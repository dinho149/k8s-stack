// Package httpx has small HTTP helpers shared by the MCP and broker servers.
package httpx

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// JSON writes v as JSON with status.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Error writes {"error":..., "code":...}.
func Error(w http.ResponseWriter, status int, code, msg string) {
	JSON(w, status, map[string]string{"error": msg, "code": code})
}

// Bearer enforces a shared bearer token (constant-time compare).
func Bearer(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			Error(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Logging logs one line per request.
func Logging(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			return
		}
		log.Info("http", "method", r.Method, "path", r.URL.Path, "status", sw.status, "dur_ms", time.Since(start).Milliseconds())
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Health mounts /healthz and /readyz.
func Health(mux *http.ServeMux, ready func() error) {
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { JSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if err := ready(); err != nil {
			JSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not-ready", "error": err.Error()})
			return
		}
		JSON(w, 200, map[string]string{"status": "ready"})
	})
}
