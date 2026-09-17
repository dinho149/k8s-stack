// Package teleport wraps the Teleport API client with the small surface this service uses, so the
// rest of the code can be unit-tested against an in-memory fake.
package teleport

import (
	"context"

	"github.com/gravitational/teleport/api/client/proto"
	"github.com/gravitational/teleport/api/types"
)

// API is the subset of *client.Client that teleport-access uses.
type API interface {
	Ping(ctx context.Context) (proto.PingResponse, error)
	GetCurrentUser(ctx context.Context) (types.User, error)
	GetUser(ctx context.Context, name string, withSecrets bool) (types.User, error)
	GetUsers(ctx context.Context, withSecrets bool) ([]types.User, error)
	GetRoles(ctx context.Context) ([]types.Role, error)
	GetRole(ctx context.Context, name string) (types.Role, error)
	GetAccessRequests(ctx context.Context, filter types.AccessRequestFilter) ([]types.AccessRequest, error)
	CreateAccessRequestV2(ctx context.Context, req types.AccessRequest) (types.AccessRequest, error)
	SetAccessRequestState(ctx context.Context, params types.AccessRequestUpdate) error
	SubmitAccessReview(ctx context.Context, params types.AccessReviewSubmission) (types.AccessRequest, error)
	GetAccessCapabilities(ctx context.Context, req types.AccessCapabilitiesRequest) (*types.AccessCapabilities, error)
	ListUnifiedResources(ctx context.Context, req *proto.ListUnifiedResourcesRequest) (*proto.ListUnifiedResourcesResponse, error)
	NewWatcher(ctx context.Context, watch types.Watch) (types.Watcher, error)
}

// Resource is a flattened view of any unified resource.
type Resource struct {
	Kind        string            `json:"kind"` // node | db | kube_cluster | app | windows_desktop
	Name        string            `json:"name"`
	Hostname    string            `json:"hostname,omitempty"`
	Addr        string            `json:"addr,omitempty"`
	Description string            `json:"description,omitempty"`
	Protocol    string            `json:"protocol,omitempty"`
	Labels      map[string]string `json:"labels"`
	Logins      []string          `json:"logins,omitempty"`
	// RequiresRequest is set by Teleport when listing with IncludeRequestable.
	RequiresRequest bool `json:"requires_request,omitempty"`
}

// FlattenResources converts a unified-resources response into Resource values.
func FlattenResources(resp *proto.ListUnifiedResourcesResponse) []Resource {
	out := make([]Resource, 0, len(resp.GetResources()))
	for _, pr := range resp.GetResources() {
		r := Resource{Logins: pr.GetLogins(), RequiresRequest: pr.GetRequiresRequest()}
		switch {
		case pr.GetNode() != nil:
			n := pr.GetNode()
			r.Kind, r.Name, r.Hostname, r.Addr, r.Labels = types.KindNode, n.GetName(), n.GetHostname(), n.GetAddr(), n.GetAllLabels()
		case pr.GetDatabaseServer() != nil:
			db := pr.GetDatabaseServer().GetDatabase()
			r.Kind, r.Name, r.Addr, r.Protocol, r.Description, r.Labels = types.KindDatabase, db.GetName(), db.GetURI(), db.GetProtocol(), db.GetDescription(), db.GetAllLabels()
		case pr.GetKubernetesServer() != nil:
			k := pr.GetKubernetesServer().GetCluster()
			r.Kind, r.Name, r.Labels = types.KindKubernetesCluster, k.GetName(), k.GetAllLabels()
		case pr.GetAppServer() != nil:
			a := pr.GetAppServer().GetApp()
			r.Kind, r.Name, r.Addr, r.Description, r.Labels = types.KindApp, a.GetName(), a.GetPublicAddr(), a.GetDescription(), a.GetAllLabels()
		case pr.GetWindowsDesktop() != nil:
			d := pr.GetWindowsDesktop()
			r.Kind, r.Name, r.Addr, r.Labels = types.KindWindowsDesktop, d.GetName(), d.GetAddr(), d.GetAllLabels()
		default:
			continue
		}
		if r.Labels == nil {
			r.Labels = map[string]string{}
		}
		out = append(out, r)
	}
	return out
}
