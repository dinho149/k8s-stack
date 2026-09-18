// Package harness connects the integration tests to the live Teleport cluster using the ci-harness
// bot identity (exported by `make harness-identity`) and offers small helpers.
package harness

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gravitational/teleport/api/client"
	"github.com/gravitational/teleport/api/types"
)

// Env holds the connection parameters from the environment.
type Env struct {
	Proxy    string
	Identity string
	Insecure bool
	// BrokerURL / BrokerToken are optional (when the broker is port-forwarded).
	BrokerURL   string
	BrokerToken string
}

// FromEnv reads TELEPORT_PROXY, HARNESS_IDENTITY, TELEPORT_INSECURE, BROKER_URL, BROKER_API_TOKEN.
func FromEnv(t *testing.T) Env {
	t.Helper()
	e := Env{Proxy: os.Getenv("TELEPORT_PROXY"), Identity: os.Getenv("HARNESS_IDENTITY"), Insecure: os.Getenv("TELEPORT_INSECURE") == "1", BrokerURL: os.Getenv("BROKER_URL"), BrokerToken: os.Getenv("BROKER_API_TOKEN")}
	if e.Proxy == "" || e.Identity == "" {
		t.Skip("TELEPORT_PROXY and HARNESS_IDENTITY not set; run `make test-integration`")
	}
	return e
}

// Connect returns a client using the harness identity.
func Connect(t *testing.T, e Env) *client.Client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	clt, err := client.New(ctx, client.Config{Addrs: []string{e.Proxy}, Credentials: []client.Credentials{client.LoadIdentityFile(e.Identity)}, InsecureAddressDiscovery: e.Insecure, DialTimeout: 20 * time.Second})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = clt.Close() })
	return clt
}

// CreateRequest creates a pending role request for user (harness has access_request:create).
func CreateRequest(t *testing.T, clt *client.Client, user string, roles []string, ttl time.Duration, reason string) types.AccessRequest {
	t.Helper()
	req, err := types.NewAccessRequest(uuid.NewString(), user, roles...)
	if err != nil {
		t.Fatal(err)
	}
	req.SetRequestReason(reason)
	req.SetAccessExpiry(time.Now().Add(ttl))
	req.SetMaxDuration(time.Now().Add(ttl))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	created, err := clt.CreateAccessRequestV2(ctx, req)
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = clt.DeleteAccessRequest(ctx, created.GetName())
	})
	return created
}

// WaitState polls until the request reaches state or the timeout passes.
func WaitState(t *testing.T, clt *client.Client, id string, want types.RequestState, timeout time.Duration) types.AccessRequest {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last types.AccessRequest
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		reqs, err := clt.GetAccessRequests(ctx, types.AccessRequestFilter{ID: id})
		cancel()
		if err == nil && len(reqs) == 1 {
			last = reqs[0]
			if last.GetState() == want {
				return last
			}
		}
		time.Sleep(2 * time.Second)
	}
	state := "unknown"
	if last != nil {
		state = last.GetState().String()
	}
	t.Fatalf("request %s did not reach %s within %s (last: %s)", id, want, timeout, state)
	return nil
}
