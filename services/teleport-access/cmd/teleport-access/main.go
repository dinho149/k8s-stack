// teleport-access: MCP server and access broker for a Teleport cluster.
//
//	teleport-access mcp      # MCP server (stdio; --http :8080 adds Streamable HTTP)
//	teleport-access broker   # access broker (watcher + HTTP API on :8081)
//	teleport-access all      # both in one process (local development)
//	teleport-access policy validate|eval
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/spf13/cobra"

	"github.com/dinho/k8s-teleport/services/teleport-access/internal/broker"
	"github.com/dinho/k8s-teleport/services/teleport-access/internal/config"
	"github.com/dinho/k8s-teleport/services/teleport-access/internal/httpx"
	mcpserver "github.com/dinho/k8s-teleport/services/teleport-access/internal/mcp"
	"github.com/dinho/k8s-teleport/services/teleport-access/internal/policy"
	"github.com/dinho/k8s-teleport/services/teleport-access/internal/teleport"
)

var version = "dev"

func main() {
	root := &cobra.Command{Use: "teleport-access", Short: "Teleport MCP server and access broker", Version: version, SilenceUsage: true}
	var httpAddr string
	mcpCmd := &cobra.Command{Use: "mcp", Short: "Run the MCP server", RunE: func(cmd *cobra.Command, _ []string) error {
		return run(cmd.Context(), "mcp", httpAddr)
	}}
	mcpCmd.Flags().StringVar(&httpAddr, "http", "", "also serve Streamable HTTP on this address (e.g. :8080); stdio is always served unless --http is set")
	brokerCmd := &cobra.Command{Use: "broker", Short: "Run the access broker", RunE: func(cmd *cobra.Command, _ []string) error { return run(cmd.Context(), "broker", "") }}
	allCmd := &cobra.Command{Use: "all", Short: "Run MCP (HTTP) and broker together", RunE: func(cmd *cobra.Command, _ []string) error { return run(cmd.Context(), "mcp,broker", httpAddr) }}
	allCmd.Flags().StringVar(&httpAddr, "http", ":8080", "MCP Streamable HTTP address")

	policyCmd := &cobra.Command{Use: "policy", Short: "Work with approval policies"}
	policyCmd.AddCommand(&cobra.Command{Use: "validate <file>", Args: cobra.ExactArgs(1), RunE: func(_ *cobra.Command, args []string) error {
		p, err := policy.Load(args[0])
		if err != nil {
			return err
		}
		fmt.Printf("ok: %d rules\n", len(p.Rules))
		return nil
	}})
	var evalRoles, evalTTL string
	evalCmd := &cobra.Command{Use: "eval <file>", Args: cobra.ExactArgs(1), RunE: func(_ *cobra.Command, args []string) error {
		p, err := policy.Load(args[0])
		if err != nil {
			return err
		}
		var ttl time.Duration
		if evalTTL != "" {
			ttl, _ = time.ParseDuration(evalTTL)
		}
		var roles []string
		for _, r := range strings.Split(evalRoles, ",") {
			if r = strings.TrimSpace(r); r != "" {
				roles = append(roles, r)
			}
		}
		dec := policy.NewEngine(p).Evaluate(policy.EvalRequest{Roles: roles, RequestedTTL: ttl})
		return json.NewEncoder(os.Stdout).Encode(dec)
	}}
	evalCmd.Flags().StringVar(&evalRoles, "roles", "", "comma separated roles")
	evalCmd.Flags().StringVar(&evalTTL, "ttl", "", "requested duration")
	policyCmd.AddCommand(evalCmd)
	root.AddCommand(mcpCmd, brokerCmd, allCmd, policyCmd)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	err := root.ExecuteContext(ctx)
	stop()
	if err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, modes, httpAddr string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if httpAddr != "" {
		cfg.MCP.HTTPAddr = httpAddr
	}
	if err := cfg.Validate(modes); err != nil {
		return err
	}
	log := newLogger(cfg, strings.Contains(modes, "mcp") && cfg.MCP.HTTPAddr == "")

	clt, err := teleport.Connect(ctx, cfg.Teleport, log)
	if err != nil {
		return err
	}
	defer func() { _ = clt.Close() }()

	policyFile := cfg.Broker.PolicyFile
	if !strings.Contains(modes, "broker") {
		policyFile = cfg.MCP.PolicyFile
	}
	engine, err := loadPolicy(ctx, policyFile, log)
	if err != nil {
		return err
	}

	errc := make(chan error, 3)
	var brokerSvc *broker.Service
	if strings.Contains(modes, "broker") {
		if engine == nil {
			return fmt.Errorf("broker requires a policy file (%s)", policyFile)
		}
		store, err := broker.NewStore(cfg.Broker.StateFile)
		if err != nil {
			return fmt.Errorf("broker state: %w", err)
		}
		store.OnError = func(err error) { log.Error("broker state file write failed", "path", cfg.Broker.StateFile, "err", err) }
		brokerSvc = &broker.Service{
			API: clt, Policy: engine, Store: store, Log: log.With("component", "broker"),
			Mode: broker.ApprovalMode(cfg.Broker.Approvals), SelfUser: clt.Username(), FallbackApproverRoles: []string{"approver"},
			Notifier: &broker.Notifier{URL: cfg.Broker.AgentWebhookURL, Secret: cfg.Broker.WebhookSecret, Log: log.With("component", "notifier")},
		}
		srv := httpx.NewServer(cfg.Broker.HTTPAddr, brokerSvc.Handler(cfg.Broker.APIToken, []byte(cfg.IdentitySigningKey)))
		go func() { errc <- serve(ctx, srv, log, "broker http") }()
		if brokerSvc.Mode != broker.ModeNative {
			go func() { errc <- brokerSvc.RunWatcher(ctx, cfg.Broker.Mode == "poll", cfg.Broker.PollInterval) }()
		} else {
			log.Info("broker in native mode: not deciding requests (Enterprise Access Monitoring Rules do)")
		}
		go func() {
			t := time.NewTicker(time.Hour)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					brokerSvc.Store.Prune(7*24*time.Hour, 24*time.Hour)
				}
			}
		}()
	}

	if strings.Contains(modes, "mcp") {
		stdio := mcpserver.Principal{TeleportUser: cfg.MCP.StdioUser, Email: cfg.MCP.StdioEmail, Source: "stdio"}
		if cfg.MCP.HTTPAddr != "" {
			// HTTP mode: identity comes only from verified assertions; no stdio principal exists.
			stdio = mcpserver.Principal{}
		} else if stdio.TeleportUser == "" {
			// Local operator: act as the identity we are connected with (their own tsh profile).
			stdio.TeleportUser = clt.Username()
		}
		srv := mcpserver.New(mcpserver.Deps{API: clt, Policy: engine, Log: log.With("component", "mcp"), Stdio: stdio, Edition: cfg.Teleport.Edition, ClusterName: clt.ClusterName(), Version: clt.ServerVersion(), ApproverRoles: []string{"approver"}})
		if cfg.MCP.HTTPAddr != "" {
			mux := http.NewServeMux()
			httpx.Health(mux, func(ctx context.Context) error { _, err := clt.Ping(ctx); return err }, 5*time.Second)
			// One handler (one session table, one replay cache) mounted at both paths.
			h := srv.HTTPHandler(cfg.MCP.SharedToken, []byte(cfg.IdentitySigningKey))
			mux.Handle("/mcp", h)
			mux.Handle("/mcp/", h)
			hs := httpx.NewServer(cfg.MCP.HTTPAddr, httpx.Logging(log.With("component", "mcp-http"), mux))
			go func() { errc <- serve(ctx, hs, log, "mcp http") }()
		} else {
			go func() { errc <- srv.RunStdio(ctx) }()
		}
	}

	select {
	case <-ctx.Done():
		return nil
	case err := <-errc:
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}

func serve(ctx context.Context, srv *http.Server, log *slog.Logger, name string) error {
	go func() {
		<-ctx.Done()
		// Shutdown must outlive the cancelled parent context; keep its values but drop the cancel.
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("listening", "server", name, "addr", srv.Addr)
	return srv.ListenAndServe()
}

// loadPolicy loads the policy file (nil when it does not exist) and hot-reloads it on change.
func loadPolicy(ctx context.Context, path string, log *slog.Logger) (*policy.Engine, error) {
	if path == "" {
		return nil, nil
	}
	if _, err := os.Stat(path); err != nil {
		log.Warn("no policy file; broker predictions disabled", "path", path)
		return nil, nil
	}
	p, err := policy.Load(path)
	if err != nil {
		return nil, err
	}
	engine := policy.NewEngine(p)
	log.Info("policy loaded", "path", path, "rules", len(p.Rules))
	go func() {
		w, err := fsnotify.NewWatcher()
		if err != nil {
			return
		}
		defer func() { _ = w.Close() }()
		_ = w.Add(path)
		_ = w.Add(dirOf(path))
		for {
			select {
			case <-ctx.Done():
				return
			case <-w.Events:
				time.Sleep(time.Second)
				np, err := policy.Load(path)
				if err != nil {
					log.Error("policy reload failed; keeping previous", "err", err)
					continue
				}
				engine.Replace(np)
				log.Info("policy reloaded", "rules", len(np.Rules))
			case <-w.Errors:
			}
		}
	}()
	return engine, nil
}

func dirOf(p string) string {
	if i := strings.LastIndex(p, "/"); i > 0 {
		return p[:i]
	}
	return "."
}

func newLogger(cfg *config.Config, stderrOnly bool) *slog.Logger {
	var lvl slog.Level
	_ = lvl.UnmarshalText([]byte(strings.ToUpper(cfg.LogLevel)))
	opts := &slog.HandlerOptions{Level: lvl}
	out := os.Stdout
	if stderrOnly {
		out = os.Stderr // stdio MCP: stdout is the protocol channel
	}
	var h slog.Handler = slog.NewJSONHandler(out, opts)
	if cfg.LogText {
		h = slog.NewTextHandler(out, opts)
	}
	l := slog.New(h).With("service", "teleport-access", "version", version)
	slog.SetDefault(l)
	return l
}
