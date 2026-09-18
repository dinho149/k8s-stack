package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/yeaboi/k8s-stack/internal/platform"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "stack:", err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return errors.New("usage: stack <init|config|doctor|serve|up|status|down|benchmark> [options]")
	}
	command := os.Args[1]
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	config := fs.String("config", "platform.yaml", "configuration path")
	name := fs.String("name", "", "environment name")
	image := fs.String("image", "", "immutable image digest")
	revision := fs.String("revision", "", "Git commit SHA")
	confirmation := fs.String("confirmation", "", "deletion confirmation ID")
	bootstrap := fs.Bool("bootstrap", false, "provision host and bootstrap base components")
	file := fs.String("file", "", "operations JSON input for benchmark summary")
	if err := fs.Parse(os.Args[2:]); err != nil {
		return err
	}
	if command == "init" {
		if _, err := os.Stat(*config); err == nil {
			return errors.New("configuration already exists")
		}
		b, e := os.ReadFile("configs/local.yaml")
		if e != nil {
			return e
		}
		return os.WriteFile(*config, b, 0600)
	}
	c, e := platform.LoadConfig(*config)
	if e != nil {
		return e
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	root, e := os.Getwd()
	if e != nil {
		return e
	}
	switch command {
	case "config":
		return json.NewEncoder(os.Stdout).Encode(c)
	case "doctor":
		failed := false
		for _, tool := range []string{"docker", "kind", "kubectl", "helm", "tofu", "node"} {
			p, e := exec.LookPath(tool)
			if e != nil {
				fmt.Printf("MISSING %s\n", tool)
				failed = true
			} else {
				fmt.Printf("OK      %-10s %s\n", tool, p)
			}
		}
		fmt.Printf("Config valid: %s / %s; inference: %s\n", c.Provider, c.Profile, c.Agent.Provider)
		if failed {
			return errors.New("missing prerequisites")
		}
		return nil
	case "serve":
		s, e := platform.OpenStore(c.StatePath, c)
		if e != nil {
			return e
		}
		defer s.Close()
		d := platform.KubernetesDriver{Root: root, Config: c}
		a, e := platform.NewAPI(ctx, s, d)
		if e != nil {
			return e
		}
		errs := make(chan error, 2)
		go func() { errs <- platform.RunWorker(ctx, s, d) }()
		go func() { errs <- platform.Serve(ctx, a) }()
		e = <-errs
		cancel()
		<-errs
		return e
	case "up":
		if *bootstrap {
			if c.Provider != "kind" && c.Provider != "existing" {
				return errors.New("provision cloud hosts using infra/aws or infra/gcp with reviewed OpenTofu plans, then bootstrap as an existing cluster")
			}
			cmd := exec.CommandContext(ctx, "bash", filepath.Join(root, "scripts", "bootstrap.sh"), *config)
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			cmd.Env = append(os.Environ(), "STACK_NAME="+c.Name, "STACK_PROVIDER="+c.Provider, "STACK_CONTEXT="+c.Context, "STACK_PROFILE="+c.Profile, "STACK_DOMAIN="+c.Domain)
			return cmd.Run()
		}
		return request(c, "POST", "/v1/environments", map[string]any{"id": *name, "image": *image, "revision": *revision, "profile": "preview", "warm": true}, *name+":"+*revision)
	case "status":
		p := "/v1/environments"
		if *name != "" {
			p += "/" + *name
		}
		return request(c, "GET", p, nil, "")
	case "down":
		if *name == "" {
			return errors.New("--name required")
		}
		if *confirmation == "" {
			return request(c, "POST", "/v1/environments/"+*name+"/confirm-delete", map[string]any{}, "")
		}
		return request(c, "POST", "/v1/environments/"+*name+"/destroy", map[string]any{"confirmation": *confirmation}, "")
	case "benchmark":
		if *file == "" {
			return request(c, "GET", "/v1/operations", nil, "")
		}
		raw, e := os.ReadFile(*file)
		if e != nil {
			return e
		}
		var ops []platform.Operation
		if e = json.Unmarshal(raw, &ops); e != nil {
			return e
		}
		var seconds []float64
		failed := 0
		for _, op := range ops {
			if op.Action != "deploy" || !op.Warm {
				continue
			}
			if op.Status == "failed" {
				failed++
			}
			if op.Status == "succeeded" && op.StartedAt != nil {
				if ready, ok := op.Timings["application-ready"]; ok {
					seconds = append(seconds, ready.Sub(*op.StartedAt).Seconds())
				}
			}
		}
		sort.Float64s(seconds)
		fmt.Printf("Warm completed launches: %d; failures: %d\n", len(seconds), failed)
		if len(seconds) == 0 {
			return errors.New("no measured warm launches")
		}
		p95 := seconds[(len(seconds)*95+99)/100-1]
		fmt.Printf("APPLICATION STARTUP p95: %.2fs (target %.0fs)\n", p95, c.Lifecycle.WarmTarget.Seconds())
		if len(seconds) < 30 {
			return errors.New("at least 30 launches required to assert the startup target")
		}
		if p95 >= c.Lifecycle.WarmTarget.Seconds() || failed > 0 {
			return errors.New("benchmark acceptance failed")
		}
		return nil
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}
func request(c platform.Config, method, path string, body any, key string) error {
	base := os.Getenv("STACK_API_URL")
	if base == "" {
		base = "http://" + c.Listen
	}
	b, e := json.Marshal(body)
	if e != nil {
		return e
	}
	r, e := http.NewRequest(method, strings.TrimRight(base, "/")+path, bytes.NewReader(b))
	if e != nil {
		return e
	}
	token := os.Getenv("STACK_TOKEN")
	if token == "" {
		token = os.Getenv("STACK_LOCAL_TOKEN")
	}
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", key)
	client := http.Client{Timeout: time.Minute}
	resp, e := client.Do(r)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	_, e = io.Copy(os.Stdout, resp.Body)
	if e != nil {
		return e
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("API returned %s", resp.Status)
	}
	return nil
}
