// Package mcpserver exposes Teleport access knowledge as MCP tools. Identity is bound to the
// transport (HTTP headers set by the trusted agent process, or the local operator on stdio), never
// to tool arguments, so a prompt-injected "act as alice" is impossible by construction.
package mcpserver

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Principal is the Teleport user a session acts for.
type Principal struct {
	TeleportUser string
	Email        string
	Source       string // http | stdio
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

const (
	HeaderUser  = "X-Teleport-User"
	HeaderEmail = "X-Teleport-User-Email"
)

// identityMiddleware derives the principal from HTTP headers (Streamable HTTP) or falls back to the
// configured stdio principal.
func identityMiddleware(stdio Principal) mcp.Middleware {
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if extra := req.GetExtra(); extra != nil && extra.Header != nil && extra.Header.Get(HeaderUser) != "" {
				ctx = WithPrincipal(ctx, Principal{TeleportUser: strings.TrimSpace(extra.Header.Get(HeaderUser)), Email: strings.TrimSpace(extra.Header.Get(HeaderEmail)), Source: "http"})
			} else if stdio.TeleportUser != "" {
				ctx = WithPrincipal(ctx, stdio)
			}
			return next(ctx, method, req)
		}
	}
}

// BearerAuth rejects HTTP requests without the shared token and requires the user header.
func BearerAuth(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		if strings.TrimSpace(r.Header.Get(HeaderUser)) == "" {
			http.Error(w, `{"error":"missing X-Teleport-User"}`, http.StatusBadRequest)
			return
		}
		next.ServeHTTP(w, r)
	})
}
