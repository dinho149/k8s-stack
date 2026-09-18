// Package mcpserver exposes Teleport access knowledge as MCP tools. Identity is bound to the
// transport (a signed per-turn identity assertion verified by the HTTP layer, or the local operator
// on stdio), never to tool arguments, so a prompt-injected "act as alice" is impossible by
// construction.
package mcpserver

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dinho/k8s-teleport/services/teleport-access/internal/assertion"
)

// Principal is the Teleport user a session acts for.
type Principal struct {
	TeleportUser   string
	Email          string
	Platform       string
	PlatformUserID string
	Source         string // http | stdio
}

type principalKey struct{}

// WithPrincipal stores p in ctx.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// PrincipalFrom returns the session principal.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok && p.TeleportUser != ""
}

// ErrNoPrincipal is returned by tools when no identity is bound to the session.
var ErrNoPrincipal = errors.New("no Teleport identity is bound to this MCP session")

// Internal headers set by BearerAuth after verifying the assertion. Any client-supplied value is
// stripped before verification, so the MCP middleware can trust them. They are the only identity
// headers ever read; X-Teleport-User / X-Teleport-User-Email are ignored.
const (
	verifiedUserHeader     = "X-Ta-Verified-User"
	verifiedEmailHeader    = "X-Ta-Verified-Email"
	verifiedPlatformHeader = "X-Ta-Verified-Platform"
	verifiedPlatformIDHdr  = "X-Ta-Verified-Platform-User-Id"
	sessionIDHeader        = "Mcp-Session-Id"
)

// identityMiddleware derives the principal from the verified headers set by BearerAuth
// (Streamable HTTP) or, for non-HTTP transports only, from the configured stdio principal. An
// HTTP request without verified headers never gets a principal.
func identityMiddleware(stdio Principal) mcp.Middleware {
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			extra := req.GetExtra()
			switch {
			case extra != nil && extra.Header != nil:
				if u := extra.Header.Get(verifiedUserHeader); u != "" {
					ctx = WithPrincipal(ctx, Principal{TeleportUser: u, Email: extra.Header.Get(verifiedEmailHeader), Platform: extra.Header.Get(verifiedPlatformHeader), PlatformUserID: extra.Header.Get(verifiedPlatformIDHdr), Source: "http"})
				}
			case stdio.TeleportUser != "":
				ctx = WithPrincipal(ctx, stdio)
			}
			return next(ctx, method, req)
		}
	}
}

// AuthOptions configures BearerAuth.
type AuthOptions struct {
	// SharedToken the agent presents as Authorization: Bearer.
	SharedToken string
	// IdentityKey verifies X-Teleport-Assertion (audience "mcp"); must be >= assertion.MinKeyLen.
	IdentityKey []byte
	// SessionTTL bounds how long a session->principal binding is remembered without traffic.
	SessionTTL time.Duration
	Log        *slog.Logger
}

// BearerAuth requires the shared bearer token AND a valid identity assertion on every HTTP
// request, binds the asserted subject to the MCP session, and hands the verified principal to the
// MCP layer through internal headers.
func BearerAuth(o AuthOptions, next http.Handler) http.Handler {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.SessionTTL <= 0 {
		o.SessionTTL = 30 * time.Minute
	}
	verifier := assertion.NewVerifier(o.IdentityKey, assertion.AudienceMCP)
	binder := newSessionBinder(o.SessionTTL)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if o.SharedToken == "" || subtle.ConstantTimeCompare([]byte(got), []byte(o.SharedToken)) != 1 {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		for _, h := range []string{verifiedUserHeader, verifiedEmailHeader, verifiedPlatformHeader, verifiedPlatformIDHdr} {
			r.Header.Del(h)
		}
		claims, err := verifier.Verify(r.Header.Get(assertion.Header))
		if err != nil {
			o.Log.Warn("identity assertion rejected", "err", err, "remote", r.RemoteAddr)
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		if sid := r.Header.Get(sessionIDHeader); sid != "" {
			if err := binder.bind(sid, claims.Sub); err != nil {
				o.Log.Warn("session identity mismatch", "session", sid, "sub", claims.Sub, "err", err)
				http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
				return
			}
		}
		r.Header.Set(verifiedUserHeader, claims.Sub)
		r.Header.Set(verifiedEmailHeader, claims.Email)
		r.Header.Set(verifiedPlatformHeader, claims.Platform)
		r.Header.Set(verifiedPlatformIDHdr, claims.PlatformUserID)
		if r.Method == http.MethodGet {
			// The server->client SSE stream is long-lived by design; the listener's WriteTimeout
			// would cut it every 30s. It is still bounded by the session timeout.
			_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
		}
		// A session id issued in the response (initialize) is bound to this subject too.
		next.ServeHTTP(&bindingWriter{ResponseWriter: w, binder: binder, sub: claims.Sub}, r)
	})
}

// bindingWriter records the Mcp-Session-Id the server assigns on initialize.
type bindingWriter struct {
	http.ResponseWriter
	binder *sessionBinder
	sub    string
	done   bool
}

func (b *bindingWriter) WriteHeader(code int) {
	if !b.done {
		b.done = true
		if sid := b.Header().Get(sessionIDHeader); sid != "" && code < 300 {
			_ = b.binder.bind(sid, b.sub)
		}
	}
	b.ResponseWriter.WriteHeader(code)
}

func (b *bindingWriter) Write(p []byte) (int, error) {
	if !b.done {
		b.WriteHeader(http.StatusOK)
	}
	return b.ResponseWriter.Write(p)
}

func (b *bindingWriter) Flush() {
	if f, ok := b.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (b *bindingWriter) Unwrap() http.ResponseWriter { return b.ResponseWriter }

// sessionBinder remembers which subject owns each MCP session (bounded, expiring).
type sessionBinder struct {
	mu   sync.Mutex
	ttl  time.Duration
	now  func() time.Time
	subs map[string]sessionOwner
}

type sessionOwner struct {
	sub  string
	seen time.Time
}

const maxBoundSessions = 10_000

var (
	errSessionOwner = errors.New("session is bound to a different subject")
	errSessionsFull = errors.New("too many live sessions")
)

func newSessionBinder(ttl time.Duration) *sessionBinder {
	return &sessionBinder{ttl: ttl, now: time.Now, subs: map[string]sessionOwner{}}
}

// bind binds sid to sub on first sight and rejects a different sub afterwards.
func (b *sessionBinder) bind(sid, sub string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	if o, ok := b.subs[sid]; ok && now.Sub(o.seen) < b.ttl {
		if o.sub != sub {
			return errSessionOwner
		}
		b.subs[sid] = sessionOwner{sub: sub, seen: now}
		return nil
	}
	if len(b.subs) >= maxBoundSessions {
		for k, o := range b.subs {
			if now.Sub(o.seen) >= b.ttl {
				delete(b.subs, k)
			}
		}
		if len(b.subs) >= maxBoundSessions {
			return errSessionsFull
		}
	}
	b.subs[sid] = sessionOwner{sub: sub, seen: now}
	return nil
}
