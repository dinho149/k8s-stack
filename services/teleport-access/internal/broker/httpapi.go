package broker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gravitational/teleport/api/types"
	"github.com/gravitational/trace"

	"github.com/dinho/k8s-teleport/services/teleport-access/internal/httpx"
	"github.com/dinho/k8s-teleport/services/teleport-access/internal/policy"
)

// Handler returns the broker HTTP API (see services/contracts/broker.openapi.yaml).
func (s *Service) Handler(apiToken string) http.Handler {
	mux := http.NewServeMux()
	httpx.Health(mux, func() error { return s.Ready(contextWithTimeout()) })

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
		reqs, err := s.API.GetAccessRequests(r.Context(), filter)
		if err != nil {
			httpx.Error(w, 502, "teleport_error", err.Error())
			return
		}
		out := []RequestView{}
		for _, ar := range reqs {
			out = append(out, s.View(ar))
		}
		httpx.JSON(w, 200, map[string]any{"requests": out})
	})
	api.HandleFunc("GET /v1/requests/{id}", func(w http.ResponseWriter, r *http.Request) {
		ar, err := s.Find(r.Context(), r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		httpx.JSON(w, 200, s.View(ar))
	})
	decide := func(approve bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				Approver Approver `json:"approver"`
				Reason   string   `json:"reason"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				httpx.Error(w, 400, "bad_json", err.Error())
				return
			}
			var ar types.AccessRequest
			var err error
			if approve {
				ar, err = s.Approve(r.Context(), r.PathValue("id"), body.Approver, body.Reason)
			} else {
				ar, err = s.Deny(r.Context(), r.PathValue("id"), body.Approver, body.Reason)
			}
			if err != nil {
				writeErr(w, err)
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
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			httpx.Error(w, 400, "bad_json", err.Error())
			return
		}
		var ttl time.Duration
		if body.TTL != "" {
			ttl, _ = time.ParseDuration(body.TTL)
		}
		var traits map[string][]string
		if u, err := s.API.GetUser(r.Context(), body.Requester, false); err == nil {
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
		httpx.JSON(w, 200, map[string]any{"approver_roles": roles, "emails": append(dec.Approvers.Emails, s.approverEmails(r.Context(), roles)...)})
	})
	api.HandleFunc("GET /v1/users/by-email", func(w http.ResponseWriter, r *http.Request) {
		u, err := s.UserByEmail(r.Context(), r.URL.Query().Get("email"))
		if err != nil {
			httpx.Error(w, 502, "teleport_error", err.Error())
			return
		}
		if u == "" {
			httpx.JSON(w, 200, map[string]any{})
			return
		}
		httpx.JSON(w, 200, map[string]any{"user": u})
	})
	api.HandleFunc("GET /v1/users/{user}/roles", func(w http.ResponseWriter, r *http.Request) {
		u, err := s.API.GetUser(r.Context(), r.PathValue("user"), false)
		if err != nil {
			writeErr(w, err)
			return
		}
		httpx.JSON(w, 200, map[string]any{"roles": u.GetRoles(), "traits": u.GetTraits()})
	})
	api.HandleFunc("GET /v1/policy", func(w http.ResponseWriter, _ *http.Request) { httpx.JSON(w, 200, s.Policy.Policy()) })

	mux.Handle("/v1/", httpx.Bearer(apiToken, api))
	return httpx.Logging(s.Log, mux)
}

func writeErr(w http.ResponseWriter, err error) {
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
	default:
		httpx.Error(w, http.StatusBadGateway, "teleport_error", err.Error())
	}
}

func contextWithTimeout() context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = cancel // short-lived readiness probe; the deadline releases resources
	return ctx
}
