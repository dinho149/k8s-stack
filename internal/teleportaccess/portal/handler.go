package portal

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gravitational/trace"
	"golang.org/x/time/rate"

	"github.com/yeaboi/k8s-stack/internal/teleportaccess/accessapi"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/httpx"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/teleport"
)

// SubjectHeader carries the authenticated portal subject (set by the Backstage backend).
const SubjectHeader = "X-Dogfood-Subject"

// API rate limit shared by every caller (the Backstage backend is the only legitimate client).
const (
	apiRateLimit = rate.Limit(50)
	apiRateBurst = 100
	// idempotencyTTL is how long a POST /v1/requests result is replayed for the same subject + key.
	idempotencyTTL = 10 * time.Minute
	maxIdempotency = 10_000
)

// Config wires the handler.
type Config struct {
	ServiceToken string
	Mapper       *Mapper
	Broker       *BrokerClient
	API          teleport.API
	Log          *slog.Logger
	Ready        func(context.Context) error
}

type principalKey struct{}

type subject struct {
	Subject   string
	Principal accessapi.Principal
}

// Handler returns the portal API (see docs/teleport/contracts/portal.openapi.yaml).
func Handler(cfg Config, svc *accessapi.Service) http.Handler {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	h := &handler{cfg: cfg, svc: svc, idem: newIdempotency(idempotencyTTL)}
	mux := http.NewServeMux()
	httpx.Health(mux, cfg.Ready, 5*time.Second)
	api := http.NewServeMux()
	api.HandleFunc("GET /v1/me", h.me)
	api.HandleFunc("GET /v1/cluster", h.cluster)
	api.HandleFunc("GET /v1/roles", h.roles)
	api.HandleFunc("GET /v1/roles/{name}", h.role)
	api.HandleFunc("GET /v1/requestable-roles", h.requestable)
	api.HandleFunc("GET /v1/resources", h.resources)
	api.HandleFunc("GET /v1/resources/accessible", h.accessible)
	api.HandleFunc("GET /v1/resources/{kind}/{name}/access", h.explain)
	api.HandleFunc("GET /v1/approvers", h.approvers)
	api.HandleFunc("POST /v1/requests/preview", h.preview)
	api.HandleFunc("POST /v1/requests", h.create)
	api.HandleFunc("GET /v1/requests", h.listMine)
	api.HandleFunc("GET /v1/requests/{id}", h.getRequest)
	api.HandleFunc("GET /v1/approvals", h.approvals)
	api.HandleFunc("POST /v1/requests/{id}/approve", h.decide(true))
	api.HandleFunc("POST /v1/requests/{id}/deny", h.decide(false))
	mux.Handle("/v1/", httpx.RateLimit(rate.NewLimiter(apiRateLimit, apiRateBurst), httpx.Bearer(cfg.ServiceToken, h.subjectAuth(api))))
	// No browser ever talks to this API directly: refuse cross-origin requests outright.
	return httpx.Logging(cfg.Log, http.NewCrossOriginProtection().Handler(mux))
}

type handler struct {
	cfg  Config
	svc  *accessapi.Service
	idem *idempotency
}

// subjectAuth turns X-Dogfood-Subject into a verified principal: the subject must map to a Teleport
// user that exists and is not a bot. Client-supplied internal identity headers are dropped first.
func (h *handler) subjectAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for k := range r.Header {
			if strings.HasPrefix(strings.ToLower(k), "x-ta-") || strings.EqualFold(k, "X-Teleport-User") || strings.EqualFold(k, "X-Teleport-User-Email") {
				r.Header.Del(k)
			}
		}
		sub := strings.TrimSpace(r.Header.Get(SubjectHeader))
		if sub == "" || len(sub) > 255 || strings.ContainsAny(sub, "\r\n\t\x00 ") {
			httpx.Error(w, http.StatusForbidden, "unmapped_subject", "no portal subject")
			return
		}
		user, ok := h.cfg.Mapper.Resolve(sub)
		if !ok {
			h.cfg.Log.Warn("portal subject not mapped", "subject", httpx.LogSafe(sub))
			httpx.Error(w, http.StatusForbidden, "unmapped_subject", "this account is not mapped to a Teleport user")
			return
		}
		if strings.HasPrefix(user, "bot-") {
			httpx.Error(w, http.StatusForbidden, "unknown_user", "not a person")
			return
		}
		ctx, cancel := requestContext(r)
		u, err := h.cfg.API.GetUser(ctx, user, false)
		cancel()
		if err != nil {
			if trace.IsNotFound(err) {
				h.cfg.Log.Warn("portal subject maps to an unknown Teleport user", "subject", httpx.LogSafe(sub), "user", httpx.LogSafe(user))
				httpx.Error(w, http.StatusForbidden, "unknown_user", "no such Teleport user")
				return
			}
			h.writeErr(w, r, err)
			return
		}
		p := accessapi.Principal{TeleportUser: user}
		if emails := u.GetTraits()["email"]; len(emails) > 0 {
			p.Email = emails[0]
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, subject{Subject: sub, Principal: p})))
	})
}

func who(r *http.Request) subject {
	s, _ := r.Context().Value(principalKey{}).(subject)
	return s
}

// ---- handlers

func (h *handler) me(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := requestContext(r)
	defer cancel()
	v, err := h.svc.Whoami(ctx, who(r).Principal)
	h.reply(w, r, v, err)
}

func (h *handler) cluster(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, 200, h.svc.ClusterInfo())
}

func (h *handler) roles(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := requestContext(r)
	defer cancel()
	v, err := h.svc.ListRoles(ctx, r.URL.Query().Get("q"))
	h.reply(w, r, v, err)
}

// role returns the detail plus whether the caller may request it and the policy prediction.
func (h *handler) role(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := requestContext(r)
	defer cancel()
	detail, err := h.svc.DescribeRole(ctx, r.PathValue("name"))
	if err != nil {
		h.writeErr(w, r, err)
		return
	}
	out := map[string]any{"role": detail.Role, "deny": detail.Deny, "kubernetes_resources": detail.KubernetesResources, "requestable": false}
	if rl, err := h.svc.ListRequestable(ctx, who(r).Principal); err == nil {
		for _, rr := range rl.RequestableRoles {
			if rr.Role == detail.Role.Name {
				out["requestable"] = true
				out["prediction"] = rr
			}
		}
	}
	httpx.JSON(w, 200, out)
}

func (h *handler) requestable(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := requestContext(r)
	defer cancel()
	v, err := h.svc.ListRequestable(ctx, who(r).Principal)
	h.reply(w, r, v, err)
}

func (h *handler) resources(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := requestContext(r)
	defer cancel()
	q := r.URL.Query()
	v, err := h.svc.Search(ctx, who(r).Principal, accessapi.SearchIn{Query: q.Get("q"), Kind: q.Get("kind"), Limit: intParam(q.Get("limit"))})
	h.reply(w, r, v, err)
}

func (h *handler) accessible(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := requestContext(r)
	defer cancel()
	q := r.URL.Query()
	v, err := h.svc.Accessible(ctx, who(r).Principal, accessapi.AccessibleIn{Kind: q.Get("kind"), Search: q.Get("q"), Limit: intParam(q.Get("limit"))})
	h.reply(w, r, v, err)
}

func (h *handler) explain(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := requestContext(r)
	defer cancel()
	v, err := h.svc.Explain(ctx, who(r).Principal, r.PathValue("name"), r.PathValue("kind"))
	h.reply(w, r, v, err)
}

func (h *handler) approvers(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := requestContext(r)
	defer cancel()
	q := r.URL.Query()
	v, err := h.svc.WhoCanApprove(ctx, who(r).Principal, accessapi.WhoCanApproveIn{Role: q.Get("role"), ResourceName: q.Get("resource")})
	h.reply(w, r, v, err)
}

func (h *handler) preview(w http.ResponseWriter, r *http.Request) {
	var in accessapi.CreateRequestIn
	if err := httpx.DecodeJSON(w, r, httpx.MaxBodyBytes, &in); err != nil {
		httpx.Error(w, 400, "bad_json", err.Error())
		return
	}
	in.DryRun = true
	ctx, cancel := requestContext(r)
	defer cancel()
	v, err := h.svc.CreateRequest(ctx, who(r).Principal, in)
	h.reply(w, r, v, err)
}

func (h *handler) create(w http.ResponseWriter, r *http.Request) {
	var in accessapi.CreateRequestIn
	if err := httpx.DecodeJSON(w, r, httpx.MaxBodyBytes, &in); err != nil {
		httpx.Error(w, 400, "bad_json", err.Error())
		return
	}
	in.DryRun = false
	s := who(r)
	if key := r.Header.Get("Idempotency-Key"); key != "" {
		if cached, ok := h.idem.get(s.Subject, key); ok {
			httpx.JSON(w, cached.status, cached.body)
			return
		}
	}
	ctx, cancel := requestContext(r)
	defer cancel()
	res, err := h.svc.CreateRequest(ctx, s.Principal, in)
	if err != nil {
		h.writeErr(w, r, err)
		return
	}
	status := http.StatusCreated
	if !res.Created {
		status = http.StatusBadGateway
	}
	if key := r.Header.Get("Idempotency-Key"); key != "" && res.Created {
		h.idem.put(s.Subject, key, status, res)
	}
	httpx.JSON(w, status, res)
}

func (h *handler) listMine(w http.ResponseWriter, r *http.Request) {
	state := strings.ToLower(r.URL.Query().Get("state"))
	switch state {
	case "", "pending", "approved", "denied":
	default:
		httpx.Error(w, 400, "bad_request", "state must be pending|approved|denied")
		return
	}
	ctx, cancel := requestContext(r)
	defer cancel()
	v, err := h.svc.ListMine(ctx, who(r).Principal, state)
	h.reply(w, r, v, err)
}

func (h *handler) getRequest(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := requestContext(r)
	defer cancel()
	v, err := h.svc.GetRequest(ctx, who(r).Principal, r.PathValue("id"))
	h.reply(w, r, v, err)
}

// approvals is the approver queue: every pending request except the caller's own (which they could
// never decide anyway).
func (h *handler) approvals(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := requestContext(r)
	defer cancel()
	s := who(r)
	list, err := h.svc.ListPending(ctx, s.Principal, r.URL.Query().Get("role"))
	if err != nil {
		h.writeErr(w, r, err)
		return
	}
	out := []accessapi.RequestView{}
	for _, v := range list.Requests {
		if v.User != s.Principal.TeleportUser {
			out = append(out, v)
		}
	}
	httpx.JSON(w, 200, accessapi.RequestList{Requests: out})
}

type decisionBody struct {
	Reason string `json:"reason"`
}

func (h *handler) decide(approve bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body decisionBody
		if err := httpx.DecodeJSON(w, r, httpx.MaxBodyBytes, &body); err != nil {
			httpx.Error(w, 400, "bad_json", "body must be {\"reason\": string}: "+err.Error())
			return
		}
		reason := accessapi.CleanReason(body.Reason)
		if len(reason) > 1024 {
			httpx.Error(w, 400, "bad_reason", "reason must be at most 1024 characters")
			return
		}
		if !approve && reason == "" {
			httpx.Error(w, 400, "bad_reason", "a reason is required to deny a request")
			return
		}
		s := who(r)
		ctx, cancel := requestContext(r)
		defer cancel()
		// Visibility and the cheap approver gate first; the broker re-verifies both against Teleport.
		if _, err := h.svc.GetRequest(ctx, s.Principal, r.PathValue("id")); err != nil {
			h.writeErr(w, r, err)
			return
		}
		if !h.svc.IsApprover(ctx, s.Principal.TeleportUser) {
			httpx.Error(w, http.StatusForbidden, "not_approver", "only approvers can decide requests")
			return
		}
		if err := h.cfg.Broker.Decide(ctx, r.PathValue("id"), approve, Approver{TeleportUser: s.Principal.TeleportUser, Email: s.Principal.Email, Subject: s.Subject}, reason); err != nil {
			if be, ok := AsBrokerError(err); ok {
				if be.Status >= 500 {
					h.cfg.Log.Error("broker decision failed", "request_id", httpx.LogSafe(r.PathValue("id")), "code", be.Code, "err", be.Message)
				}
				httpx.Error(w, be.Status, be.Code, be.Message)
				return
			}
			h.writeErr(w, r, err)
			return
		}
		h.cfg.Log.Info("portal decision", "request_id", httpx.LogSafe(r.PathValue("id")), "approve", approve, "by", s.Principal.TeleportUser)
		v, err := h.svc.GetRequest(ctx, s.Principal, r.PathValue("id"))
		h.reply(w, r, v, err)
	}
}

// ---- helpers

func (h *handler) reply(w http.ResponseWriter, r *http.Request, v any, err error) {
	if err != nil {
		h.writeErr(w, r, err)
		return
	}
	httpx.JSON(w, 200, v)
}

// writeErr maps service and Teleport errors to HTTP responses. Only well-typed Teleport errors carry
// their message through; anything else is logged and reported generically.
func (h *handler) writeErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case trace.IsNotFound(err):
		httpx.Error(w, http.StatusNotFound, "not_found", trace.UserMessage(err))
	case trace.IsBadParameter(err):
		code := "bad_request"
		if strings.Contains(err.Error(), "policy denies") {
			code = "policy_denied"
		}
		httpx.Error(w, http.StatusBadRequest, code, trace.UserMessage(err))
	case trace.IsAccessDenied(err):
		httpx.Error(w, http.StatusForbidden, "teleport_denied", trace.UserMessage(err))
	case trace.IsLimitExceeded(err):
		w.Header().Set("Retry-After", "60")
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited", trace.UserMessage(err))
	case errors.Is(err, context.DeadlineExceeded):
		h.cfg.Log.Error("teleport call timed out", "route", r.Pattern, "err", err)
		httpx.Error(w, http.StatusGatewayTimeout, "teleport_timeout", "teleport did not answer in time")
	default:
		h.cfg.Log.Error("teleport call failed", "route", r.Pattern, "err", err)
		httpx.Error(w, http.StatusBadGateway, "teleport_error", "teleport error")
	}
}

func requestContext(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), 15*time.Second)
}

func intParam(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// idempotency replays a successful create for the same subject + Idempotency-Key (bounded, expiring).
type idempotency struct {
	mu  sync.Mutex
	ttl time.Duration
	now func() time.Time
	m   map[string]idemEntry
}

type idemEntry struct {
	status int
	body   any
	at     time.Time
}

func newIdempotency(ttl time.Duration) *idempotency {
	return &idempotency{ttl: ttl, now: time.Now, m: map[string]idemEntry{}}
}

func (i *idempotency) get(subject, key string) (idemEntry, bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	e, ok := i.m[subject+"\x00"+key]
	if !ok || i.now().Sub(e.at) > i.ttl {
		return idemEntry{}, false
	}
	return e, true
}

func (i *idempotency) put(subject, key string, status int, body any) {
	i.mu.Lock()
	defer i.mu.Unlock()
	now := i.now()
	if len(i.m) >= maxIdempotency {
		for k, e := range i.m {
			if now.Sub(e.at) > i.ttl {
				delete(i.m, k)
			}
		}
		if len(i.m) >= maxIdempotency {
			return
		}
	}
	i.m[subject+"\x00"+key] = idemEntry{status: status, body: body, at: now}
}
