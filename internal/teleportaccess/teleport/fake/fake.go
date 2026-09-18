// Package fake is an in-memory teleport.API for unit tests.
package fake

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gravitational/teleport/api/client/proto"
	"github.com/gravitational/teleport/api/types"
	"github.com/gravitational/trace"
)

// API implements teleport.API in memory.
type API struct {
	mu        sync.Mutex
	Users     map[string]types.User
	Roles     map[string]types.Role
	Requests  map[string]types.AccessRequest
	Resources *proto.ListUnifiedResourcesResponse
	// Requestable maps user -> roles they may request (what GetAccessCapabilities returns).
	Requestable map[string][]string
	Me          string
	events      chan types.Event
	// Hooks
	OnSetState func(types.AccessRequestUpdate) error
}

func New() *API {
	return &API{Users: map[string]types.User{}, Roles: map[string]types.Role{}, Requests: map[string]types.AccessRequest{}, Resources: &proto.ListUnifiedResourcesResponse{}, Requestable: map[string][]string{}, Me: "bot-test", events: make(chan types.Event, 64)}
}

func (f *API) Ping(context.Context) (proto.PingResponse, error) {
	return proto.PingResponse{ClusterName: "test.cluster", ServerVersion: "18.0.0-fake"}, nil
}

func (f *API) GetCurrentUser(ctx context.Context) (types.User, error) {
	if u, ok := f.Users[f.Me]; ok {
		return u, nil
	}
	u, _ := types.NewUser(f.Me)
	return u, nil
}

func (f *API) GetUser(_ context.Context, name string, _ bool) (types.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if u, ok := f.Users[name]; ok {
		return u, nil
	}
	return nil, trace.NotFound("user %q not found", name)
}

func (f *API) GetUsers(context.Context, bool) ([]types.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]types.User, 0, len(f.Users))
	for _, u := range f.Users {
		out = append(out, u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetName() < out[j].GetName() })
	return out, nil
}

func (f *API) GetRoles(context.Context) ([]types.Role, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]types.Role, 0, len(f.Roles))
	for _, r := range f.Roles {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetName() < out[j].GetName() })
	return out, nil
}

func (f *API) GetRole(_ context.Context, name string) (types.Role, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r, ok := f.Roles[name]; ok {
		return r, nil
	}
	return nil, trace.NotFound("role %q not found", name)
}

func (f *API) GetAccessRequests(_ context.Context, filter types.AccessRequestFilter) ([]types.AccessRequest, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []types.AccessRequest
	for _, r := range f.Requests {
		if filter.ID != "" && r.GetName() != filter.ID {
			continue
		}
		if filter.User != "" && r.GetUser() != filter.User {
			continue
		}
		if filter.State != types.RequestState_NONE && r.GetState() != filter.State {
			continue
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetCreationTime().Before(out[j].GetCreationTime()) })
	return out, nil
}

func (f *API) CreateAccessRequestV2(_ context.Context, req types.AccessRequest) (types.AccessRequest, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if req.GetName() == "" {
		req.SetName(uuid.NewString())
	}
	if req.GetCreationTime().IsZero() {
		req.SetCreationTime(time.Now())
	}
	if req.GetAccessExpiry().IsZero() {
		req.SetAccessExpiry(time.Now().Add(8 * time.Hour))
	}
	f.Requests[req.GetName()] = req
	f.emit(types.OpPut, req)
	return req, nil
}

func (f *API) SetAccessRequestState(_ context.Context, p types.AccessRequestUpdate) error {
	if f.OnSetState != nil {
		if err := f.OnSetState(p); err != nil {
			return err
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.Requests[p.RequestID]
	if !ok {
		return trace.NotFound("request %q not found", p.RequestID)
	}
	if r.GetState() != types.RequestState_PENDING {
		return trace.AlreadyExists("request already resolved")
	}
	_ = r.SetState(p.State)
	r.SetResolveReason(p.Reason)
	if len(p.Annotations) > 0 {
		r.SetResolveAnnotations(p.Annotations)
	}
	f.emit(types.OpPut, r)
	return nil
}

func (f *API) SubmitAccessReview(_ context.Context, p types.AccessReviewSubmission) (types.AccessRequest, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.Requests[p.RequestID]
	if !ok {
		return nil, trace.NotFound("request %q not found", p.RequestID)
	}
	r.SetReviews(append(r.GetReviews(), p.Review))
	_ = r.SetState(p.Review.ProposedState)
	f.emit(types.OpPut, r)
	return r, nil
}

func (f *API) GetAccessCapabilities(_ context.Context, req types.AccessCapabilitiesRequest) (*types.AccessCapabilities, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &types.AccessCapabilities{RequestableRoles: f.Requestable[req.User], SuggestedReviewers: []string{"admin"}}, nil
}

func (f *API) ListUnifiedResources(_ context.Context, req *proto.ListUnifiedResourcesRequest) (*proto.ListUnifiedResourcesResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Resources, nil
}

// Events returns the fake event stream (used by NewWatcher).
func (f *API) emit(op types.OpType, r types.Resource) {
	select {
	case f.events <- types.Event{Type: op, Resource: r}:
	default:
	}
}

func (f *API) NewWatcher(ctx context.Context, _ types.Watch) (types.Watcher, error) {
	w := &watcher{events: make(chan types.Event, 64), done: make(chan struct{})}
	w.events <- types.Event{Type: types.OpInit}
	go func() {
		defer close(w.done)
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-f.events:
				w.events <- ev
			}
		}
	}()
	return w, nil
}

type watcher struct {
	events chan types.Event
	done   chan struct{}
}

func (w *watcher) Events() <-chan types.Event { return w.events }
func (w *watcher) Done() <-chan struct{}      { return w.done }
func (w *watcher) Close() error               { return nil }
func (w *watcher) Error() error               { return nil }
