package broker

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gravitational/teleport/api/types"
	"github.com/gravitational/trace"
	"golang.org/x/time/rate"

	"github.com/dinho/k8s-teleport/services/teleport-access/internal/assertion"
	"github.com/dinho/k8s-teleport/services/teleport-access/internal/httpx"
	"github.com/dinho/k8s-teleport/services/teleport-access/internal/policy"
)

// API rate limit shared by every caller (the agent is the only legitimate client).
const (
	apiRateLimit = rate.Limit(50)
	apiRateBurst = 100
)

// decisionBody is the only accepted body for approve/deny. The approver identity never comes from
// the body: it is taken from the verified X-Teleport-Assertion header.
type decisionBody struct {
	Reason string `json:"reason"`
}

// Handler returns the broker HTTP API (see services/contracts/broker.openapi.yaml). Every /v1
// route needs the bearer token; approve/deny additionally need a valid identity assertion signed
// with identityKey (audience "broker").
func (s *Service) Handler(apiToken string, identityKey []byte) http.Handler {
	verifier := assertion.NewVerifier(identityKey, assertion.AudienceBroker)
	mux := http.NewServeMux()
	httpx.Health(mux, s.Ready, 5*time.Second)

	api := http.NewServeMux()
	api.HandleFunc("GET /v1/requests", func(w http.ResponseWriter, r *http.Request) {
		state := strings.ToUpper(r.URL.Query().Get("state"))
		if state == "" {
			state = "PENDING"
		}
		filter := types.AccessRequestFilter{}
		switch state {
		case "PENDING":
			filter.State = types.RequestState_PENDING
		case "APPROVED":
			filter.State = types.RequestState_APPROVED
		case "DENIED":
			filter.State = types.RequestState_DENIED
		case "ALL":
		default:
			httpx.Error(w, 400, "bad_state", "state must be pending|approved|denied|all")
			return
		}
		ctx, cancel := requestContext(r)
		defer cancel()
		reqs, err := s.API.GetAccessRequests(ctx, filter)
		if err != nil {
			s.writeErr(w, r, err)
			return
		}
		out := []RequestView{}
		for _, ar := range reqs {
			out = append(out, s.View(ar))
		}
		httpx.JSON(w, 200, map[string]any{"requests": out})
	})
	api.HandleFunc("GET /v1/requests/{id}", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := requestContext(r)
		defer cancel()
		ar, err := s.Find(ctx, r.PathValue("id"))
		if err != nil {
			s.writeErr(w, r, err)
			return
		}
		httpx.JSON(w, 200, s.View(ar))
	})
	decide := func(approve bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			claims, err := verifier.Verify(r.Header.Get(assertion.Header))
			if err != nil {
				s.Log.Warn("approver assertion rejected", "route", r.Pattern, "err", err)
				httpx.Error(w, http.StatusUnauthorized, "unauthorized", "missing or invalid identity assertion")
				return
			}
			var body decisionBody
			if err := httpx.DecodeJSON(w, r, httpx.MaxBodyBytes, &body); err != nil {
				httpx.Error(w, 400, "bad_json", "body must be {\"reason\": string}: "+err.Error())
				return
			}
			if len(body.Reason) > 1024 {
				httpx.Error(w, 400, "bad_reason", "reason must be at most 1024 characters")
				return
			}
			by := Approver{TeleportUser: claims.Sub, Email: claims.Email, Adapter: claims.Platform, PlatformUserID: claims.PlatformUserID}
			ctx, cancel := requestContext(r)
			defer cancel()
			var ar types.AccessRequest
			if approve {
				ar, err = s.Approve(ctx, r.PathValue("id"), by, body.Reason)
			} else {
				ar, err = s.Deny(ctx, r.PathValue("id"), by, body.Reason)
			}
			if err != nil {
				s.writeErr(w, r, err)
				return
			}
			httpx.JSON(w, 200, s.View(ar))
		}
	}
	api.HandleFunc("POST /v1/requests/{id}/approve", decide(true))
	api.HandleFunc("POST /v1/requests/{id}/deny", decide(false))
	api.HandleFunc("POST /v1/policy/evaluate", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Requester string   `json:"requester"`
			Roles     []string `json:"roles"`
			TTL       string   `json:"ttl"`
		}
		if err := httpx.DecodeJSON(w, r, httpx.MaxBodyBytes, &body); err != nil {
			httpx.Error(w, 400, "bad_json", err.Error())
			return
		}
		if len(body.Roles) > 50 {
			httpx.Error(w, 400, "bad_request", "too many roles")
			return
		}
		var ttl time.Duration
		if body.TTL != "" {
			d, err := time.ParseDuration(body.TTL)
			if err != nil || d < 0 {
				httpx.Error(w, 400, "bad_request", "ttl must be a duration like 2h")
				return
			}
			ttl = d
		}
		ctx, cancel := requestContext(r)
		defer cancel()
		var traits map[string][]string
		if u, err := s.API.GetUser(ctx, body.Requester, false); err == nil {
			traits = u.GetTraits()
		}
		httpx.JSON(w, 200, decisionView(s.Policy.Evaluate(policy.EvalRequest{Requester: body.Requester, Roles: body.Roles, Traits: traits, RequestedTTL: ttl})))
	})
	api.HandleFunc("GET /v1/approvers", func(w http.ResponseWriter, r *http.Request) {
		dec := s.Policy.Evaluate(policy.EvalRequest{Roles: []string{r.URL.Query().Get("role")}})
		roles := dec.Approvers.TeleportRoles
		if len(roles) == 0 {
			roles = s.FallbackApproverRoles
		}
		ctx, cancel := requestContext(r)
		defer cancel()
		httpx.JSON(w, 200, map[string]any{"approver_roles": roles, "emails": append(dec.Approvers.Emails, s.approverEmails(ctx, roles)...)})
	})
	api.HandleFunc("GET /v1/users/by-email", func(w http.ResponseWriter, r *http.Request) {
		email := r.URL.Query().Get("email")
		if email == "" || len(email) > 320 {
			httpx.Error(w, 400, "bad_request", "email is required")
			return
		}
		ctx, cancel := requestContext(r)
		defer cancel()
		u, err := s.UserByEmail(ctx, email)
		if err != nil {
			s.writeErr(w, r, err)
			return
		}
		if u == "" {
			httpx.JSON(w, 200, map[string]any{})
			return
		}
		httpx.JSON(w, 200, map[string]any{"user": u})
	})
	api.HandleFunc("GET /v1/users/{user}/roles", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := requestContext(r)
		defer cancel()
		u, err := s.API.GetUser(ctx, r.PathValue("user"), false)
		if err != nil {
			s.writeErr(w, r, err)
			return
		}
		// Traits (emails, logins, group memberships) are intentionally not exposed.
		httpx.JSON(w, 200, map[string]any{"roles": u.GetRoles()})
	})

	mux.Handle("/v1/", httpx.RateLimit(rate.NewLimiter(apiRateLimit, apiRateBurst), httpx.Bearer(apiToken, api)))
	return httpx.Logging(s.Log, mux)
}

// writeErr maps service and Teleport errors to HTTP responses. Only well-typed Teleport errors
// carry their message through; anything else is logged and reported generically.
func (s *Service) writeErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotPending):
		httpx.Error(w, http.StatusConflict, "not_pending", err.Error())
	case errors.Is(err, ErrSelfApproval):
		httpx.Error(w, http.StatusForbidden, "self_approval", err.Error())
	case errors.Is(err, ErrNotApprover):
		httpx.Error(w, http.StatusForbidden, "not_approver", err.Error())
	case errors.Is(err, ErrNativeMode):
		httpx.Error(w, http.StatusNotImplemented, "native_mode", err.Error())
	case trace.IsNotFound(err):
		httpx.Error(w, http.StatusNotFound, "not_found", trace.UserMessage(err))
	case trace.IsBadParameter(err):
		httpx.Error(w, http.StatusBadRequest, "bad_request", trace.UserMessage(err))
	case trace.IsAccessDenied(err):
		httpx.Error(w, http.StatusForbidden, "teleport_denied", trace.UserMessage(err))
	case errors.Is(err, context.DeadlineExceeded):
		s.Log.Error("teleport call timed out", "route", r.Pattern, "err", err)
		httpx.Error(w, http.StatusGatewayTimeout, "teleport_timeout", "teleport did not answer in time")
	default:
		s.Log.Error("teleport call failed", "route", r.Pattern, "err", err)
		httpx.Error(w, http.StatusBadGateway, "teleport_error", "teleport error")
	}
}

// requestContext bounds every Teleport call made on behalf of an HTTP request.
func requestContext(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), 15*time.Second)
}
