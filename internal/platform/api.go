package platform

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

type API struct {
	Store        *Store
	verifier     *oidc.IDTokenVerifier
	serviceToken string
	localToken   string
	Inspector    Inspector
}
type Inspector interface {
	ToolAvailability(context.Context) (map[string]bool, error)
	Policies(context.Context) (json.RawMessage, error)
	Diagnostics(context.Context, Environment) (json.RawMessage, error)
}

func NewAPI(ctx context.Context, s *Store, inspector Inspector) (*API, error) {
	a := &API{Store: s, Inspector: inspector, serviceToken: os.Getenv("STACK_SERVICE_TOKEN"), localToken: os.Getenv("STACK_LOCAL_TOKEN")}
	if a.serviceToken != "" && len(a.serviceToken) < 32 {
		return nil, errors.New("STACK_SERVICE_TOKEN must contain at least 32 characters")
	}
	if s.Config.Auth.Issuer != "" {
		p, e := oidc.NewProvider(ctx, s.Config.Auth.Issuer)
		if e != nil {
			return nil, e
		}
		a.verifier = p.Verifier(&oidc.Config{ClientID: s.Config.Auth.ClientID})
	}
	if s.Config.Profile == "local" && a.localToken != "" {
		host, _, e := net.SplitHostPort(s.Config.Listen)
		if e != nil {
			return nil, e
		}
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return nil, errors.New("local token authentication requires a loopback listener")
		}
		if len(a.localToken) < 32 {
			return nil, errors.New("STACK_LOCAL_TOKEN must contain at least 32 characters")
		}
	}
	if a.verifier == nil && a.localToken == "" && a.serviceToken == "" {
		return nil, errors.New("configure OIDC or explicit local/service authentication")
	}
	return a, nil
}
func equalSecret(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	x := sha256.Sum256([]byte(a))
	y := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(x[:], y[:]) == 1
}
func (a *API) auth(r *http.Request) (Identity, error) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if equalSecret(token, a.serviceToken) {
		u, ok := a.Store.Config.Identity(r.Header.Get("X-Stack-Subject"))
		if !ok {
			return Identity{}, ErrForbidden
		}
		return u, nil
	}
	if a.Store.Config.Profile == "local" && equalSecret(token, a.localToken) {
		u, ok := a.Store.Config.Identity("local-developer")
		if ok {
			return u, nil
		}
	}
	if a.verifier != nil {
		t, e := a.verifier.Verify(r.Context(), token)
		if e == nil {
			if u, ok := a.Store.Config.Identity(t.Subject); ok {
				return u, nil
			}
		}
	}
	return Identity{}, ErrForbidden
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func failure(w http.ResponseWriter, e error) {
	status := http.StatusBadRequest
	if errors.Is(e, ErrForbidden) {
		status = 403
	}
	if errors.Is(e, ErrNotFound) {
		status = 404
	}
	if errors.Is(e, ErrConflict) {
		status = 409
	}
	writeJSON(w, status, map[string]string{"error": e.Error()})
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return ErrInvalid
	}
	var trailing any
	if e := d.Decode(&trailing); e != io.EOF {
		return ErrInvalid
	}
	return nil
}
func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /metrics", a.metrics)
	mux.HandleFunc("/v1/", a.handle)
	mux.HandleFunc("/internal/", a.internal)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(w, r)
	})
}
func (a *API) handle(w http.ResponseWriter, r *http.Request) {
	u, err := a.auth(r)
	if err != nil {
		failure(w, ErrForbidden)
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/"), "/")
	parts := strings.Split(path, "/")
	if path == "promotions" && r.Method == "POST" {
		var input PromotionRequest
		if err = decode(w, r, &input); err != nil {
			failure(w, err)
			return
		}
		out, e := a.Store.RequestPromotion(r.Context(), u, input)
		if e != nil {
			failure(w, e)
			return
		}
		writeJSON(w, 202, out)
		return
	}
	if path == "tools" && r.Method == "GET" {
		type entry struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			URL         string `json:"url"`
			Status      string `json:"status"`
		}
		available := map[string]bool{}
		availabilityErr := errors.New("unavailable")
		if a.Inspector != nil {
			available, availabilityErr = a.Inspector.ToolAvailability(r.Context())
		}
		out := []entry{}
		for _, t := range []struct{ name, description, host string }{{"Argo CD", "Deployment health and GitOps", "argocd"}, {"Grafana", "Metrics, logs and traces", "grafana"}, {"Keycloak", "Identity and access", "keycloak"}, {"OpenCost", "Environment cost allocation", "opencost"}} {
			scheme, suffix := "https://", ""
			if a.Store.Config.Profile == "local" {
				scheme = "http://"
				suffix = ":18080"
			}
			status := "unknown"
			if availabilityErr == nil {
				status = "not-installed"
				if available[t.host] {
					status = "installed"
				}
			}
			out = append(out, entry{t.name, t.description, scheme + t.host + "." + a.Store.Config.Domain + suffix, status})
		}
		writeJSON(w, 200, out)
		return
	}
	if path == "me" && r.Method == "GET" {
		writeJSON(w, 200, u)
		return
	}
	if path == "link-code" && r.Method == "POST" {
		code := id()
		err = a.Store.transaction(func(st *State) error {
			st.LinkCodes[code] = LinkCode{u.Subject, a.Store.Now().Add(5 * time.Minute)}
			return nil
		})
		if err != nil {
			failure(w, err)
			return
		}
		writeJSON(w, 201, map[string]string{"code": code, "instructions": "Send /link <code> to the bot in a personal conversation within five minutes."})
		return
	}
	if path == "environments" && r.Method == "POST" {
		var input CreateRequest
		if err = decode(w, r, &input); err == nil {
			var op Operation
			op, err = a.Store.Create(u, input, r.Header.Get("Idempotency-Key"))
			if err == nil {
				writeJSON(w, 202, op)
				return
			}
		}
		failure(w, err)
		return
	}
	st, err := a.Store.Snapshot()
	if err != nil {
		slog.Error("state read failed", "error", err)
		writeJSON(w, 500, map[string]string{"error": "state unavailable"})
		return
	}
	if path == "environments" && r.Method == "GET" {
		out := []Environment{}
		for _, e := range st.Environments {
			if allowed(u, e) {
				out = append(out, e)
			}
		}
		writeJSON(w, 200, out)
		return
	}
	if path == "operations" && r.Method == "GET" {
		out := []Operation{}
		for _, op := range st.Operations {
			if e, ok := st.Environments[op.EnvironmentID]; ok && allowed(u, e) {
				out = append(out, op)
			}
		}
		writeJSON(w, 200, out)
		return
	}
	if path == "audit" && r.Method == "GET" {
		if u.Role != "admin" {
			failure(w, ErrForbidden)
			return
		}
		writeJSON(w, 200, st.Audit)
		return
	}
	if path == "policies" && r.Method == "GET" {
		out := map[string]any{"retrievedAt": a.Store.Now(), "lifecycle": a.Store.Config.Lifecycle, "role": u.Role, "source": "platform.yaml", "enforcement": "enforced", "notes": "Preview operations are owner-scoped. Global cluster policy details are restricted to platform admins."}
		if u.Role == "admin" && a.Inspector != nil {
			p, e := a.Inspector.Policies(r.Context())
			if e != nil {
				out["clusterError"] = e.Error()
			} else {
				out["clusterPolicies"] = p
			}
		}
		writeJSON(w, 200, out)
		return
	}
	if len(parts) == 2 && parts[0] == "operations" && r.Method == "GET" {
		op, ok := st.Operations[parts[1]]
		if !ok {
			failure(w, ErrNotFound)
			return
		}
		if !allowed(u, st.Environments[op.EnvironmentID]) {
			failure(w, ErrForbidden)
			return
		}
		writeJSON(w, 200, op)
		return
	}
	if len(parts) < 2 || parts[0] != "environments" {
		failure(w, ErrNotFound)
		return
	}
	env, ok := st.Environments[parts[1]]
	if !ok {
		failure(w, ErrNotFound)
		return
	}
	if !allowed(u, env) {
		failure(w, ErrForbidden)
		return
	}
	if len(parts) == 2 && r.Method == "GET" {
		writeJSON(w, 200, env)
		return
	}
	if len(parts) != 3 {
		failure(w, ErrNotFound)
		return
	}
	action := parts[2]
	if action == "diagnostics" && r.Method == "GET" {
		if a.Inspector == nil {
			failure(w, errors.New("inspector unavailable"))
			return
		}
		out, e := a.Inspector.Diagnostics(r.Context(), env)
		if e != nil {
			failure(w, e)
			return
		}
		writeJSON(w, 200, out)
		return
	}
	if r.Method != "POST" {
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	switch action {
	case "extend":
		var input struct {
			Mode       string `json:"mode"`
			Minutes    int    `json:"minutes"`
			Generation int    `json:"generation"`
		}
		if err = decode(w, r, &input); err == nil {
			var out Environment
			out, err = a.Store.Extend(u, env.ID, input.Mode, input.Minutes, input.Generation)
			if err == nil {
				writeJSON(w, 200, out)
				return
			}
		}
	case "confirm-delete":
		var out Confirmation
		out, err = a.Store.ConfirmDelete(u, env.ID)
		if err == nil {
			writeJSON(w, 201, out)
			return
		}
	case "destroy":
		var input struct {
			Confirmation string `json:"confirmation"`
		}
		if err = decode(w, r, &input); err == nil {
			var out Operation
			out, err = a.Store.Delete(u, env.ID, input.Confirmation)
			if err == nil {
				writeJSON(w, 202, out)
				return
			}
		}
	case "redeploy":
		var input struct {
			Revision   string `json:"revision"`
			Image      string `json:"image"`
			Generation int    `json:"generation"`
		}
		if err = decode(w, r, &input); err == nil {
			var out Operation
			out, err = a.Store.Redeploy(u, env.ID, input.Revision, input.Image, input.Generation)
			if err == nil {
				writeJSON(w, 202, out)
				return
			}
		}
	default:
		err = ErrNotFound
	}
	_ = a.Store.transaction(func(st *State) error { audit(st, a.Store.Now(), u.Subject, action, env.ID, "rejected"); return nil })
	failure(w, err)
}
func linkKey(channel, tenant, user string) string { return channel + "/" + tenant + "/" + user }
func (a *API) internal(w http.ResponseWriter, r *http.Request) {
	if !equalSecret(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), a.serviceToken) {
		failure(w, ErrForbidden)
		return
	}
	switch r.URL.Path {
	case "/internal/link":
		if r.Method != "POST" {
			failure(w, ErrInvalid)
			return
		}
		var in struct {
			Code        string `json:"code"`
			Channel     string `json:"channel"`
			Tenant      string `json:"tenant"`
			User        string `json:"user"`
			Destination string `json:"destination"`
		}
		if e := decode(w, r, &in); e != nil {
			failure(w, e)
			return
		}
		if in.Channel != "slack" && in.Channel != "teams" && in.Channel != "google" {
			failure(w, ErrInvalid)
			return
		}
		if in.Tenant == "" || in.User == "" || in.Destination == "" {
			failure(w, ErrInvalid)
			return
		}
		var out Link
		err := a.Store.transaction(func(st *State) error {
			code, ok := st.LinkCodes[in.Code]
			if !ok || !a.Store.Now().Before(code.ExpiresAt) {
				return ErrForbidden
			}
			out = Link{in.Channel, in.Tenant, in.User, code.Subject, in.Destination}
			st.Links[linkKey(in.Channel, in.Tenant, in.User)] = out
			delete(st.LinkCodes, in.Code)
			audit(st, a.Store.Now(), code.Subject, "link", in.Channel, "linked")
			return nil
		})
		if err != nil {
			failure(w, err)
			return
		}
		writeJSON(w, 200, out)
	case "/internal/identity":
		st, e := a.Store.Snapshot()
		if e != nil {
			failure(w, e)
			return
		}
		q := r.URL.Query()
		link, ok := st.Links[linkKey(q.Get("channel"), q.Get("tenant"), q.Get("user"))]
		if !ok {
			failure(w, ErrForbidden)
			return
		}
		u, ok := a.Store.Config.Identity(link.Subject)
		if !ok {
			failure(w, ErrForbidden)
			return
		}
		writeJSON(w, 200, u)
	case "/internal/notifications":
		if r.Method != "POST" {
			failure(w, ErrInvalid)
			return
		}
		var out []map[string]any
		e := a.Store.transaction(func(st *State) error {
			now := a.Store.Now()
			for k, n := range st.Notifications {
				if n.Delivered || n.Cancelled || n.NotBefore.After(now) {
					continue
				}
				if _, ok := a.Store.Config.Identity(n.Owner); !ok {
					continue
				}
				links := []Link{}
				for _, l := range st.Links {
					if l.Subject == n.Owner {
						links = append(links, l)
					}
				}
				if len(links) == 0 {
					continue
				}
				n.Attempts++
				n.NotBefore = now.Add(time.Minute * time.Duration(min(60, 1<<min(n.Attempts, 6))))
				st.Notifications[k] = n
				out = append(out, map[string]any{"notification": n, "environment": st.Environments[n.EnvironmentID], "destinations": links})
				if len(out) >= 20 {
					break
				}
			}
			return nil
		})
		if e != nil {
			failure(w, e)
			return
		}
		if out == nil {
			out = []map[string]any{}
		}
		writeJSON(w, 200, out)
	case "/internal/notifications/valid":
		st, e := a.Store.Snapshot()
		if e != nil {
			failure(w, e)
			return
		}
		n, ok := st.Notifications[r.URL.Query().Get("id")]
		writeJSON(w, 200, map[string]bool{"valid": ok && !n.Cancelled && !n.Delivered})
	case "/internal/notifications/ack":
		var in struct {
			ID string `json:"id"`
		}
		if e := decode(w, r, &in); e != nil {
			failure(w, e)
			return
		}
		e := a.Store.transaction(func(st *State) error {
			n, ok := st.Notifications[in.ID]
			if !ok {
				return ErrNotFound
			}
			n.Delivered = true
			st.Notifications[in.ID] = n
			return nil
		})
		if e != nil {
			failure(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		failure(w, ErrNotFound)
	}
}
func Serve(ctx context.Context, a *API) error {
	s := &http.Server{Addr: a.Store.Config.Listen, Handler: a.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.Shutdown(c)
	}()
	fmt.Printf("Lifecycle API listening on %s\n", s.Addr)
	e := s.ListenAndServe()
	if errors.Is(e, http.ErrServerClosed) {
		return nil
	}
	return e
}
