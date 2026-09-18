package assertion

import (
	"testing"
	"time"
)

// Cross-check: the vector produced by the TypeScript agent must verify with the Go implementation.
func TestCrossCheckTypeScriptVector(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	now := time.Unix(1700000000, 0)
	mcp := "eyJzdWIiOiJhbGljZSIsImVtYWlsIjoiYWxpY2VAZXhhbXBsZS5jb20iLCJwbGF0Zm9ybSI6InNsYWNrIiwicGxhdGZvcm1fdXNlcl9pZCI6IlUwMTIzQUJDIiwiYXVkIjoibWNwIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAwNDUsImp0aSI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCJ9.yHylOoWMz7JIsYpljVS00XqoOZ2MRlkKIH8meHiTvAQ"
	broker := "eyJzdWIiOiJhbGljZSIsImVtYWlsIjoiYWxpY2VAZXhhbXBsZS5jb20iLCJwbGF0Zm9ybSI6InNsYWNrIiwicGxhdGZvcm1fdXNlcl9pZCI6IlUwMTIzQUJDIiwiYXVkIjoiYnJva2VyIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAwNDUsImp0aSI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCJ9.ZfbFjdLMGPp8vcVthjoAklJewfR09yzkhrAOvIFhi88"
	p, err := Verify(key, mcp, AudienceMCP, now)
	if err != nil {
		t.Fatalf("mcp vector: %v", err)
	}
	if p.Sub != "alice" || p.Email != "alice@example.com" || p.Platform != "slack" || p.PlatformUserID != "U0123ABC" {
		t.Fatalf("mcp payload mismatch: %+v", p)
	}
	if _, err := Verify(key, broker, AudienceBroker, now); err != nil {
		t.Fatalf("broker vector: %v", err)
	}
	if _, err := Verify(key, mcp, AudienceBroker, now); err == nil {
		t.Fatal("aud confusion must fail")
	}
}
