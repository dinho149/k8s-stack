package platform

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAuthenticationCannotBeSpoofedByHeader(t *testing.T) {
	s, _ := setup(t)
	a := &API{Store: s, serviceToken: strings.Repeat("s", 32), localToken: strings.Repeat("l", 32)}
	for _, token := range []string{"", "bad"} {
		r := httptest.NewRequest("GET", "/v1/environments", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("X-Dogfood-Subject", "local-developer")
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatal(w.Code)
		}
	}
}
func TestHealthIsPublicAndStateIsPrivate(t *testing.T) {
	s, _ := setup(t)
	a := &API{Store: s}
	r := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
}
func TestJSONRejectsUnknownAndTrailingFields(t *testing.T) {
	for _, body := range []string{`{"unexpected":true}`, `{} {}`} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		w := httptest.NewRecorder()
		var in struct{}
		if decode(w, r, &in) == nil {
			t.Fatal("accepted", body)
		}
	}
}

func TestRedactionPreservesJSON(t *testing.T) {
	value := redactValues(map[string]any{"message": "password=abc token=xyz", "items": []any{"Bearer secret"}}).(map[string]any)
	if value["message"] != "[REDACTED] [REDACTED]" {
		t.Fatal(value)
	}
}

func TestMetricsRequireConfiguredScrapeCredential(t *testing.T) {
	s, _ := setup(t)
	t.Setenv("DOGFOOD_METRICS_TOKEN", strings.Repeat("m", 32))
	a := &API{Store: s, serviceToken: strings.Repeat("s", 32)}
	for _, tc := range []struct {
		token  string
		status int
	}{{"", 403}, {"wrong", 403}, {strings.Repeat("m", 32), 200}, {strings.Repeat("s", 32), 200}} {
		r := httptest.NewRequest("GET", "/metrics", nil)
		r.Header.Set("Authorization", "Bearer "+tc.token)
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("got %d, want %d", w.Code, tc.status)
		}
		if tc.status == 200 && !strings.Contains(w.Body.String(), "dogfood_launch_duration_seconds_bucket") {
			t.Fatal("missing startup histogram")
		}
	}
}

func TestDogfoodServiceIdentityHeader(t *testing.T) {
	s, _ := setup(t)
	token := strings.Repeat("s", 32)
	a := &API{Store: s, serviceToken: token}
	for _, tc := range []struct {
		header string
		status int
	}{
		{"X-Dogfood-Subject", http.StatusOK},
		{"X-Stack-Subject", http.StatusForbidden},
	} {
		r := httptest.NewRequest("GET", "/v1/environments", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set(tc.header, "local-developer")
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s: got %d, want %d", tc.header, w.Code, tc.status)
		}
	}
}
