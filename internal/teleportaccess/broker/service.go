package broker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/gravitational/teleport/api/client/proto"
	"github.com/gravitational/teleport/api/types"
	"github.com/gravitational/trace"

	"github.com/yeaboi/k8s-stack/internal/teleportaccess/access"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/policy"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/teleport"
)

// ApprovalMode selects how approvals reach Teleport.
type ApprovalMode string

const (
	// ModeSetState uses SetAccessRequestState (Community Edition; needs access_request:update).
	ModeSetState ApprovalMode = "setstate"
	// ModeReview uses SubmitAccessReview on behalf of the approver (Enterprise thresholds).
	ModeReview ApprovalMode = "review"
	// ModeNative disables automatic decisions (Enterprise Access Monitoring Rules do them).
	ModeNative ApprovalMode = "native"
)

// Service holds the broker's decision logic.
type Service struct {
	API      teleport.API
	Policy   *policy.Engine
	Store    *Store
	Notifier *Notifier
	Log      *slog.Logger
	Mode     ApprovalMode
	// SelfUser is the bot's own username; it never acts on its own requests.
	SelfUser string
	// FallbackApproverRoles is used when a decision names no approver roles.
	FallbackApproverRoles []string

	notifyOnce sync.Once
	notifySem  chan struct{}
}

// maxConcurrentNotifications bounds webhook fan-out (each delivery retries with backoff).
const maxConcurrentNotifications = 8

// Approver identifies the human who clicked approve/deny.
type Approver struct {
	TeleportUser   string `json:"teleport_user"`
	Email          string `json:"email"`
	Adapter        string `json:"adapter"`
	PlatformUserID string `json:"platform_user_id"`
}

// Errors returned by Approve/Deny; the HTTP layer maps them to codes.
var (
	ErrNotPending   = errors.New("request is not pending")
	ErrSelfApproval = errors.New("requester cannot decide their own request")
	ErrNotApprover  = errors.New("user is not an approver for this request")
	ErrNativeMode   = errors.New("approvals are handled natively by Teleport in this edition")
)

// RequestView is the JSON shape shared with the agent (contracts/broker.openapi.yaml).
type RequestView struct {
	ID           string           `json:"id"`
	User         string           `json:"user"`
	Roles        []string         `json:"roles"`
	ResourceIDs  []string         `json:"resource_ids"`
	Reason       string           `json:"reason"`
	State        string           `json:"state"`
	Created      string           `json:"created"`
	Expires      string           `json:"expires"`
	AccessExpiry string           `json:"access_expiry,omitempty"`
	Decision     *DecisionView    `json:"decision,omitempty"`
	Resolution   *Resolution      `json:"resolution,omitempty"`
	Reviews      []map[string]any `json:"reviews,omitempty"`
}

// DecisionView is the policy outcome in JSON.
type DecisionView struct {
	Action    string           `json:"action"`
	Rule      string           `json:"rule"`
	Reason    string           `json:"reason"`
	TTLCap    string           `json:"ttl_cap"`
	Approvers policy.Approvers `json:"approvers"`
}

func decisionView(d policy.Decision) *DecisionView {
	return &DecisionView{Action: string(d.Action), Rule: d.Rule, Reason: d.Reason, TTLCap: d.TTLCap.String(), Approvers: d.Approvers}
}

// View builds a RequestView from a Teleport request plus our record.
func (s *Service) View(r types.AccessRequest) RequestView {
	v := RequestView{ID: r.GetName(), User: r.GetUser(), Roles: r.GetRoles(), ResourceIDs: []string{}, Reason: r.GetRequestReason(), State: stateString(r.GetState()),
		Created: r.GetCreationTime().UTC().Format(time.RFC3339), Expires: r.GetAccessExpiry().UTC().Format(time.RFC3339), AccessExpiry: r.GetAccessExpiry().UTC().Format(time.RFC3339)}
	for _, id := range r.GetRequestedResourceIDs() {
		v.ResourceIDs = append(v.ResourceIDs, types.ResourceIDToString(id))
	}
	for _, rev := range r.GetReviews() {
		v.Reviews = append(v.Reviews, map[string]any{"author": rev.Author, "state": stateString(rev.ProposedState), "reason": rev.Reason, "created": rev.Created.UTC().Format(time.RFC3339)})
	}
	if rec, ok := s.Store.Get(r.GetName()); ok {
		v.Decision = decisionView(rec.Decision)
		v.Resolution = rec.Resolution
	}
	return v
}

func stateString(st types.RequestState) string {
	switch st {
	case types.RequestState_PENDING:
		return "PENDING"
	case types.RequestState_APPROVED:
		return "APPROVED"
	case types.RequestState_DENIED:
		return "DENIED"
	case types.RequestState_PROMOTED:
		return "PROMOTED"
	}
	return st.String()
}

// Handle processes a (possibly repeated) pending request event. Idempotent per request id.
func (s *Service) Handle(ctx context.Context, r types.AccessRequest) error {
	id := r.GetName()
	if r.GetState() != types.RequestState_PENDING {
		return s.handleResolved(ctx, r)
	}
	if r.GetUser() == s.SelfUser {
		s.Log.Warn("ignoring request made by the broker's own identity", "request_id", id)
		return nil
	}
	if rec, ok := s.Store.Get(id); ok && (!rec.NotifiedAt.IsZero() || !rec.ResolvedAt.IsZero()) {
		return nil // already handled
	}
	ev := s.evalRequest(ctx, r)
	dec := s.Policy.Evaluate(ev)
	if dec.Action == policy.ActionAutoApprove {
		// Belt and braces on top of the engine's own per-role confirmation: every role alone must be
		// auto-approvable, and a request with no roles never is.
		if len(ev.Roles) == 0 {
			s.Log.Warn("downgrading auto-approve: request has no roles", "request_id", id)
			dec.Action, dec.Rule, dec.Reason = policy.ActionRequireApproval, policy.RuleMixedTier, "requests without roles are not auto-approvable"
		}
		for _, role := range ev.Roles {
			single := ev
			single.Roles = []string{role}
			if sd := s.Policy.Evaluate(single); sd.Action != policy.ActionAutoApprove {
				s.Log.Warn("downgrading auto-approve: role alone is not auto-approvable", "request_id", id, "role", role, "single_action", sd.Action, "single_rule", sd.Rule)
				dec.Action, dec.Rule = policy.ActionRequireApproval, policy.RuleMixedTier
				dec.Reason = fmt.Sprintf("role %q alone is not auto-approvable (%s)", role, sd.Reason)
				if sd.Action == policy.ActionDeny {
					dec.Action, dec.Rule, dec.Reason = policy.ActionDeny, sd.Rule, sd.Reason
					break
				}
			}
		}
	}
	rec := &Record{ID: id, User: r.GetUser(), Roles: r.GetRoles(), Decision: dec, SeenAt: time.Now()}
	s.Log.Info("broker decision", "request_id", id, "user", r.GetUser(), "roles", r.GetRoles(), "rule", dec.Rule, "action", dec.Action, "reason", dec.Reason)

	if s.Mode == ModeNative {
		rec.NotifiedAt = time.Now()
		s.Store.Put(rec)
		return nil
	}

	switch dec.Action {
	case policy.ActionAutoApprove:
		err := s.resolve(ctx, r, types.RequestState_APPROVED, dec.Reason, map[string][]string{"access-broker/rule": {dec.Rule}, "access-broker/mode": {"auto"}}, s.SelfUser)
		if err != nil {
			return fmt.Errorf("auto-approve %s: %w", id, err)
		}
		rec.ResolvedAt = time.Now()
		rec.Resolution = &Resolution{State: "approved", By: s.SelfUser, Mode: "auto", Reason: dec.Reason}
		s.Store.Put(rec)
		s.notify(ctx, r, rec, "request.resolved")
	case policy.ActionDeny:
		err := s.resolve(ctx, r, types.RequestState_DENIED, dec.Reason, map[string][]string{"access-broker/rule": {dec.Rule}, "access-broker/mode": {"auto"}}, s.SelfUser)
		if err != nil {
			return fmt.Errorf("auto-deny %s: %w", id, err)
		}
		rec.ResolvedAt = time.Now()
		rec.Resolution = &Resolution{State: "denied", By: s.SelfUser, Mode: "auto", Reason: dec.Reason}
		s.Store.Put(rec)
		s.notify(ctx, r, rec, "request.resolved")
	default:
		rec.NotifiedAt = time.Now()
		s.Store.Put(rec)
		s.notify(ctx, r, rec, "request.pending_review")
	}
	return nil
}

func (s *Service) handleResolved(ctx context.Context, r types.AccessRequest) error {
	rec, ok := s.Store.Get(r.GetName())
	if !ok || !rec.ResolvedAt.IsZero() {
		return nil
	}
	// Resolved outside the broker (tctl, web UI, plugin).
	by := "teleport"
	if revs := r.GetReviews(); len(revs) > 0 {
		by = revs[len(revs)-1].Author
	}
	state := "denied"
	if r.GetState() == types.RequestState_APPROVED {
		state = "approved"
	}
	rec.ResolvedAt = time.Now()
	rec.Resolution = &Resolution{State: state, By: by, Mode: "external", Reason: r.GetResolveReason()}
	s.Store.Put(rec)
	s.notify(ctx, r, rec, "request.resolved")
	return nil
}

// evalRequest builds the policy input for r (traits, resource labels, requested TTL).
func (s *Service) evalRequest(ctx context.Context, r types.AccessRequest) policy.EvalRequest {
	var traits map[string][]string
	if u, err := s.API.GetUser(ctx, r.GetUser(), false); err == nil {
		traits = u.GetTraits()
	}
	var labels []map[string]string
	for _, id := range r.GetRequestedResourceIDs() {
		if res, _, err := access.ResolveResource(ctx, s.API, id.Name, id.Kind); err == nil && res != nil {
			labels = append(labels, res.Labels)
		}
	}
	// Role-only requests: derive labels from the roles' own selectors (conservative: every selector
	// value of every role is turned into one pseudo-resource so rules with resource_labels can match).
	if len(labels) == 0 {
		for _, name := range r.GetRoles() {
			role, err := s.API.GetRole(ctx, name)
			if err != nil {
				continue
			}
			for _, sel := range []types.Labels{role.GetNodeLabels(types.Allow), role.GetDatabaseLabels(types.Allow), role.GetKubernetesLabels(types.Allow), role.GetAppLabels(types.Allow)} {
				for k, vals := range sel {
					for _, v := range vals {
						labels = append(labels, map[string]string{k: v})
					}
				}
			}
		}
	}
	ttl := time.Until(r.GetAccessExpiry())
	if md := r.GetMaxDuration(); !md.IsZero() && md.Before(r.GetAccessExpiry()) {
		ttl = time.Until(md)
	}
	return policy.EvalRequest{Requester: r.GetUser(), Roles: r.GetRoles(), ResourceLabels: labels, Traits: traits, RequestedTTL: ttl.Round(time.Minute)}
}

// resolve applies the decision to Teleport.
//
// The TTL of an approved request is not adjusted here: types.AccessRequestUpdate has no expiry
// field. TTL is bounded by the policy's requested_ttl_max matching (a request asking for longer
// simply does not match the auto-approve rule) together with Teleport's own request.max_duration
// and role max_session_ttl.
func (s *Service) resolve(ctx context.Context, r types.AccessRequest, state types.RequestState, reason string, ann map[string][]string, author string) error {
	switch s.Mode {
	case ModeReview:
		_, err := s.API.SubmitAccessReview(ctx, types.AccessReviewSubmission{RequestID: r.GetName(), Review: types.AccessReview{Author: author, ProposedState: state, Reason: reason, Created: time.Now(), Annotations: ann}})
		return err
	default:
		upd := types.AccessRequestUpdate{RequestID: r.GetName(), State: state, Reason: reason, Annotations: ann}
		return s.API.SetAccessRequestState(ctx, upd)
	}
}

// Approve records a human approval (from chat).
func (s *Service) Approve(ctx context.Context, id string, by Approver, reason string) (types.AccessRequest, error) {
	return s.humanDecision(ctx, id, by, reason, types.RequestState_APPROVED)
}

// Deny records a human denial (from chat).
func (s *Service) Deny(ctx context.Context, id string, by Approver, reason string) (types.AccessRequest, error) {
	return s.humanDecision(ctx, id, by, reason, types.RequestState_DENIED)
}

func (s *Service) humanDecision(ctx context.Context, id string, by Approver, reason string, state types.RequestState) (types.AccessRequest, error) {
	if s.Mode == ModeNative {
		return nil, ErrNativeMode
	}
	r, err := s.Find(ctx, id)
	if err != nil {
		return nil, err
	}
	if r.GetState() != types.RequestState_PENDING {
		return r, ErrNotPending
	}
	if err := s.authorizeApprover(ctx, r, by); err != nil {
		return r, err
	}
	verb := "approved"
	if state == types.RequestState_DENIED {
		verb = "denied"
	}
	full := fmt.Sprintf("%s via %s by %s", verb, by.Adapter, by.TeleportUser)
	if by.Email != "" {
		full += " (" + by.Email + ")"
	}
	if reason != "" {
		full += ": " + reason
	}
	ann := map[string][]string{"access-broker/mode": {"chat"}, "access-broker/approver": {by.TeleportUser}, "access-broker/channel": {by.Adapter}}
	if rec, ok := s.Store.Get(id); ok {
		ann["access-broker/rule"] = []string{rec.Decision.Rule}
	}
	if err := s.resolve(ctx, r, state, full, ann, by.TeleportUser); err != nil {
		return r, err
	}
	rec, ok := s.Store.Get(id)
	if !ok {
		rec = &Record{ID: id, User: r.GetUser(), Roles: r.GetRoles(), SeenAt: time.Now()}
	}
	rec.ResolvedAt = time.Now()
	rec.Resolution = &Resolution{State: verb, By: by.TeleportUser, Mode: "chat", Reason: reason}
	s.Store.Put(rec)
	s.Log.Info("human decision", "request_id", id, "state", verb, "by", by.TeleportUser, "adapter", by.Adapter)
	updated, err := s.Find(ctx, id)
	if err != nil {
		updated = r
	}
	s.notify(ctx, updated, rec, "request.resolved")
	return updated, nil
}

// authorizeApprover decides whether by may decide r. The approver identity comes from a verified
// assertion; it is still cross-checked against Teleport: the user must exist, must not be the
// requester (by name or by email trait, case-insensitively), and must hold an approver role or be
// listed by an email that is one of their own Teleport email traits.
func (s *Service) authorizeApprover(ctx context.Context, r types.AccessRequest, by Approver) error {
	if by.TeleportUser == "" {
		return ErrNotApprover
	}
	if strings.EqualFold(by.TeleportUser, r.GetUser()) {
		return ErrSelfApproval
	}
	u, err := s.API.GetUser(ctx, by.TeleportUser, false)
	if err != nil {
		return ErrNotApprover
	}
	ownEmails := u.GetTraits()["email"]
	if requester, err := s.API.GetUser(ctx, r.GetUser(), false); err == nil {
		for _, re := range requester.GetTraits()["email"] {
			if re == "" {
				continue
			}
			if by.Email != "" && strings.EqualFold(re, by.Email) {
				return ErrSelfApproval
			}
			for _, oe := range ownEmails {
				if strings.EqualFold(re, oe) {
					return ErrSelfApproval
				}
			}
		}
	}
	rec, _ := s.Store.Get(r.GetName())
	var allowedRoles, allowedEmails []string
	if rec != nil {
		allowedRoles, allowedEmails = rec.Decision.Approvers.TeleportRoles, rec.Decision.Approvers.Emails
	}
	if len(allowedRoles) == 0 {
		allowedRoles = s.FallbackApproverRoles
	}
	// Email allow-list: only when the asserted email is one of the approver's own Teleport traits.
	if by.Email != "" && containsFold(ownEmails, by.Email) {
		for _, e := range allowedEmails {
			if strings.EqualFold(e, by.Email) {
				return nil
			}
		}
	}
	for _, have := range u.GetRoles() {
		for _, want := range allowedRoles {
			if have == want {
				return nil
			}
		}
		// Enterprise: a role whose review_requests cover every requested role.
		if role, err := s.API.GetRole(ctx, have); err == nil {
			if coversAll(role.GetAccessReviewConditions(types.Allow).Roles, r.GetRoles()) {
				return nil
			}
		}
	}
	return ErrNotApprover
}

func containsFold(xs []string, x string) bool {
	for _, v := range xs {
		if strings.EqualFold(v, x) {
			return true
		}
	}
	return false
}

func coversAll(reviewable, wanted []string) bool {
	if len(reviewable) == 0 {
		return false
	}
	for _, w := range wanted {
		ok := false
		for _, rv := range reviewable {
			if rv == "*" || rv == w {
				ok = true
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

// Find loads a request by id or unique prefix.
func (s *Service) Find(ctx context.Context, id string) (types.AccessRequest, error) {
	if len(id) >= 36 {
		reqs, err := s.API.GetAccessRequests(ctx, types.AccessRequestFilter{ID: id})
		if err == nil && len(reqs) == 1 {
			return reqs[0], nil
		}
	}
	all, err := s.API.GetAccessRequests(ctx, types.AccessRequestFilter{})
	if err != nil {
		return nil, err
	}
	var match types.AccessRequest
	for _, r := range all {
		if strings.HasPrefix(r.GetName(), id) {
			if match != nil {
				return nil, trace.BadParameter("request id prefix %q is ambiguous", id)
			}
			match = r
		}
	}
	if match == nil {
		return nil, trace.NotFound("access request %q not found", id)
	}
	return match, nil
}

// Pending lists pending requests as views.
func (s *Service) Pending(ctx context.Context) ([]RequestView, error) {
	reqs, err := s.API.GetAccessRequests(ctx, types.AccessRequestFilter{State: types.RequestState_PENDING})
	if err != nil {
		return nil, err
	}
	out := []RequestView{}
	for _, r := range reqs {
		out = append(out, s.View(r))
	}
	return out, nil
}

// Reconcile handles every pending request (startup and watcher reconnects).
func (s *Service) Reconcile(ctx context.Context) error {
	reqs, err := s.API.GetAccessRequests(ctx, types.AccessRequestFilter{State: types.RequestState_PENDING})
	if err != nil {
		return err
	}
	for _, r := range reqs {
		if err := s.Handle(ctx, r); err != nil {
			s.Log.Error("reconcile", "request_id", r.GetName(), "err", err)
		}
	}
	return nil
}

func (s *Service) notify(ctx context.Context, r types.AccessRequest, rec *Record, typ string) {
	if s.Notifier == nil || s.Notifier.URL == "" {
		return
	}
	ev := Event{Type: typ, Request: s.View(r), Resolution: rec.Resolution}
	if u, err := s.API.GetUser(ctx, r.GetUser(), false); err == nil {
		if emails := u.GetTraits()["email"]; len(emails) > 0 {
			ev.RequesterEmail = emails[0]
		}
	}
	if typ == "request.pending_review" {
		ev.Notify = &NotifyTarget{MentionApprovers: rec.Decision.Notify.MentionApprovers}
		for _, c := range rec.Decision.Notify.Channels {
			ev.Notify.Channels = append(ev.Notify.Channels, Channel{Adapter: c.Adapter, Target: c.Target})
		}
		ev.ApproverEmails = append(ev.ApproverEmails, rec.Decision.Approvers.Emails...)
		if rec.Decision.Notify.MentionApprovers {
			ev.ApproverEmails = append(ev.ApproverEmails, s.approverEmails(ctx, rec.Decision.Approvers.TeleportRoles)...)
		}
	}
	s.notifyOnce.Do(func() { s.notifySem = make(chan struct{}, maxConcurrentNotifications) })
	go func() {
		s.notifySem <- struct{}{}
		defer func() { <-s.notifySem }()
		bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		defer cancel()
		if err := s.Notifier.Send(bg, ev); err != nil {
			s.Log.Error("notify agent", "request_id", r.GetName(), "type", typ, "err", err)
		}
	}()
}

func (s *Service) approverEmails(ctx context.Context, roles []string) []string {
	users, err := s.API.GetUsers(ctx, false)
	if err != nil {
		return nil
	}
	var out []string
	for _, u := range users {
		for _, have := range u.GetRoles() {
			for _, want := range roles {
				if have == want {
					if emails := u.GetTraits()["email"]; len(emails) > 0 {
						out = append(out, emails[0])
					}
				}
			}
		}
	}
	return out
}

// UserByEmail finds the Teleport user whose email trait matches.
func (s *Service) UserByEmail(ctx context.Context, email string) (string, error) {
	users, err := s.API.GetUsers(ctx, false)
	if err != nil {
		return "", err
	}
	for _, u := range users {
		for _, e := range u.GetTraits()["email"] {
			if strings.EqualFold(e, email) {
				return u.GetName(), nil
			}
		}
	}
	return "", nil
}

// Ready reports whether Teleport answers.
func (s *Service) Ready(ctx context.Context) error {
	_, err := s.API.Ping(ctx)
	return err
}

// ensure proto import is used (ListUnifiedResources typed through access package)
var _ = proto.ListUnifiedResourcesRequest{}
