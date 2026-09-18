package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

type Driver interface {
	Run(context.Context, Operation, Environment, func(string) error) error
}
type KubernetesDriver struct {
	Root   string
	Config Config
}

func (d KubernetesDriver) Run(ctx context.Context, op Operation, e Environment, phase func(string) error) error {
	script := "preview-up.sh"
	if op.Action == "destroy" {
		script = "preview-down.sh"
	}
	cmd := exec.CommandContext(ctx, "bash", filepath.Join(d.Root, "scripts", script), e.ID, e.Image, e.Revision)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = 5 * time.Second
	cmd.Dir = d.Root
	cmd.Env = append(os.Environ(), "STACK_CONTEXT="+d.Config.Context, "STACK_DOMAIN="+d.Config.Domain, "STACK_PROFILE="+d.Config.Profile, "STACK_REPOSITORY="+d.Config.Repository)
	// Scripts only emit known phase markers on stdout. Diagnostic stderr stays on the server.
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Stdout = &phaseWriter{phase: phase}
	if err := cmd.Run(); err != nil {
		slog.Error("cluster operation failed", "operation", op.ID, "diagnostic", redact(stderr.String()))
		return fmt.Errorf("%s failed; inspect server logs using operation %s", op.Action, op.ID)
	}
	return nil
}

type phaseWriter struct {
	pending string
	phase   func(string) error
}

func (p *phaseWriter) Write(b []byte) (int, error) {
	p.pending += string(b)
	for strings.Contains(p.pending, "\n") {
		line, rest, _ := strings.Cut(p.pending, "\n")
		p.pending = rest
		if strings.HasPrefix(line, "STACK_PHASE=") {
			phase := strings.TrimPrefix(line, "STACK_PHASE=")
			if phase == "cluster-ready" || phase == "platform-ready" || phase == "application-ready" {
				if e := p.phase(phase); e != nil {
					return len(b), e
				}
			}
		}
	}
	return len(b), nil
}
func RunWorker(ctx context.Context, s *Store, d Driver) error {
	if err := s.Recover(); err != nil {
		return err
	}
	type running struct {
		op     Operation
		cancel context.CancelFunc
	}
	type result struct {
		id  string
		err error
	}
	active := map[string]running{}
	done := make(chan result, s.Config.Lifecycle.MaxPreviews)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	defer func() {
		for _, r := range active {
			r.cancel()
		}
		for range active {
			<-done
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return nil
		case result := <-done:
			r := active[result.id]
			r.cancel()
			delete(active, result.id)
			if err := s.Finish(result.id, result.err); err != nil {
				return err
			}
		case <-tick.C:
			if err := s.Reconcile(); err != nil {
				return err
			}
			st, err := s.Snapshot()
			if err != nil {
				return err
			}
			busy := map[string]bool{}
			for id, r := range active {
				busy[r.op.EnvironmentID] = true
				if st.Operations[id].Status == "superseded" {
					r.cancel()
				}
			}
			for len(active) < s.Config.Lifecycle.MaxPreviews {
				op, env, ok, err := s.claimExcept(busy)
				if err != nil {
					return err
				}
				if !ok {
					break
				}
				runCtx, cancel := context.WithTimeout(ctx, s.Config.Lifecycle.OperationTimeout)
				active[op.ID] = running{op, cancel}
				busy[env.ID] = true
				go func() {
					err := d.Run(runCtx, op, env, func(p string) error { return s.Phase(op.ID, p) })
					done <- result{op.ID, err}
				}()
			}
		}
	}
}

var secretRE = regexp.MustCompile(`(?i)(bearer\s+\S+|(?:password|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+)`)

func redact(s string) string { return secretRE.ReplaceAllString(s, "[REDACTED]") }
func (d KubernetesDriver) kubectl(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if d.Config.Context != "in-cluster" {
		args = append([]string{"--context", d.Config.Context}, args...)
	}
	cmd := exec.CommandContext(ctx, "kubectl", args...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("cluster query unavailable")
	}
	return out, nil
}
func (d KubernetesDriver) Policies(ctx context.Context) (json.RawMessage, error) {
	return d.kubectl(ctx, "get", "clusterpolicies.kyverno.io", "-o", "json")
}
func (d KubernetesDriver) Diagnostics(ctx context.Context, e Environment) (json.RawMessage, error) {
	if !nameRE.MatchString(e.ID) {
		return nil, ErrInvalid
	}
	raw, err := d.kubectl(ctx, "get", "events", "-n", "preview-"+e.ID, "-o", "json")
	if err != nil {
		return nil, err
	}
	var events map[string]any
	if err = json.Unmarshal(raw, &events); err != nil {
		return nil, err
	}
	out, _ := json.Marshal(map[string]any{"environment": e.ID, "retrievedAt": time.Now().UTC(), "events": redactValues(events)})
	return json.RawMessage(out), nil
}

func redactValues(v any) any {
	switch x := v.(type) {
	case string:
		return redact(x)
	case map[string]any:
		for key, value := range x {
			x[key] = redactValues(value)
		}
		return x
	case []any:
		for i, value := range x {
			x[i] = redactValues(value)
		}
		return x
	default:
		return v
	}
}

func (d KubernetesDriver) ToolAvailability(ctx context.Context) (map[string]bool, error) {
	raw, err := d.kubectl(ctx, "get", "services", "-A", "-o", "json")
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err = json.Unmarshal(raw, &list); err != nil {
		return nil, err
	}
	out := map[string]bool{}
	names := map[string]string{"argocd/argocd-server": "argocd", "monitoring/monitoring-grafana": "grafana", "identity/keycloak": "keycloak", "opencost/opencost": "opencost"}
	for _, svc := range list.Items {
		if name, ok := names[svc.Metadata.Namespace+"/"+svc.Metadata.Name]; ok {
			out[name] = true
		}
	}
	return out, nil
}
