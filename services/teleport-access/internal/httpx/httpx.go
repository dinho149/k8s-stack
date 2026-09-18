// Package httpx has small HTTP helpers shared by the MCP and broker servers.
package httpx

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// MaxBodyBytes is the default request body limit for JSON APIs.
const MaxBodyBytes int64 = 64 << 10

// Server timeouts applied to every listener.
const (
	ReadTimeout    = 15 * time.Second
	WriteTimeout   = 30 * time.Second
	IdleTimeout    = 60 * time.Second
	MaxHeaderBytes = 64 << 10
)

// NewServer builds an http.Server with the hardened timeouts.
func NewServer(addr string, h http.Handler) *http.Server {
	return &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: ReadTimeout, WriteTimeout: WriteTimeout, IdleTimeout: IdleTimeout, MaxHeaderBytes: MaxHeaderBytes}
}

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

// DecodeJSON reads at most max bytes of r.Body into v, rejecting unknown fields and trailing data.
func DecodeJSON(w http.ResponseWriter, r *http.Request, max int64, v any) error {
	body := http.MaxBytesReader(w, r.Body, max)
	defer func() { _ = body.Close() }()
	dec := json.NewDecoder(body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return errors.New("request body too large")
		}
		return err
	}
	if _, err := dec.Token(); err != io.EOF {
		return errors.New("unexpected data after JSON body")
	}
	return nil
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

// RateLimit rejects requests with 429 once the shared limiter is exhausted.
func RateLimit(l *rate.Limiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.Allow() {
			w.Header().Set("Retry-After", "1")
			Error(w, http.StatusTooManyRequests, "rate_limited", "too many requests")
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

// Unwrap lets http.ResponseController reach the underlying writer.
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Health mounts /healthz and /readyz. Readiness calls ready with a 5s deadline, caches the outcome
// for cacheFor, and never leaks error text to the client.
func Health(mux *http.ServeMux, ready func(context.Context) error, cacheFor time.Duration) {
	var mu sync.Mutex
	var checkedAt time.Time
	var lastErr error
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { JSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if time.Since(checkedAt) >= cacheFor {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			lastErr = ready(ctx)
			cancel()
			checkedAt = time.Now()
		}
		err := lastErr
		mu.Unlock()
		if err != nil {
			JSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not-ready"})
			return
		}
		JSON(w, 200, map[string]string{"status": "ok"})
	})
}
