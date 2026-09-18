package assertion

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

var key = []byte("0123456789abcdef0123456789abcdef")

func payload(now time.Time) Payload {
	return Payload{Sub: "alice", Email: "alice@example.com", Platform: "slack", PlatformUserID: "U1", Aud: AudienceMCP, Iat: now.Unix(), Exp: now.Unix() + 30, JTI: uuid.NewString()}
}

func mustSign(t *testing.T, k []byte, p Payload) string {
	t.Helper()
	h, err := Sign(k, p)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestWireFormat(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	h := mustSign(t, key, payload(now))
	body, sig, ok := strings.Cut(h, ".")
	if !ok || strings.ContainsAny(h, "=+/") {
		t.Fatalf("expected unpadded base64url body.sig, got %q", h)
	}
	if _, err := base64.RawURLEncoding.DecodeString(body); err != nil {
		t.Fatal(err)
	}
	if b, err := base64.RawURLEncoding.DecodeString(sig); err != nil || len(b) != 32 {
		t.Fatalf("sig should be 32 raw bytes: %v %d", err, len(b))
	}
	p, err := Verify(key, h, AudienceMCP, now)
	if err != nil || p.Sub != "alice" || p.Email != "alice@example.com" || p.Platform != "slack" || p.PlatformUserID != "U1" {
		t.Fatalf("verify: %v %+v", err, p)
	}
}

func TestVerifyTable(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	other := []byte("ffffffffffffffffffffffffffffffff")
	good := payload(now)
	cases := []struct {
		name   string
		header func() string
		aud    string
		at     time.Time
		want   error
	}{
		{"ok", func() string { return mustSign(t, key, good) }, AudienceMCP, now, nil},
		{"missing", func() string { return "" }, AudienceMCP, now, ErrMissing},
		{"no dot", func() string { return strings.ReplaceAll(mustSign(t, key, good), ".", "_") }, AudienceMCP, now, ErrMalformed},
		{"wrong key", func() string { return mustSign(t, other, good) }, AudienceMCP, now, ErrSignature},
		{"tampered payload", func() string {
			h := mustSign(t, key, good)
			p := Payload(good)
			p.Sub = "bob"
			h2 := mustSign(t, key, p)
			return strings.Split(h2, ".")[0] + "." + strings.Split(h, ".")[1]
		}, AudienceMCP, now, ErrSignature},
		{"wrong aud", func() string { return mustSign(t, key, good) }, AudienceBroker, now, ErrAudience},
		{"expired", func() string { return mustSign(t, key, good) }, AudienceMCP, now.Add(31 * time.Second), ErrExpired},
		{"future iat beyond skew", func() string {
			p := good
			p.Iat, p.Exp = now.Unix()+31, now.Unix()+61
			return mustSign(t, key, p)
		}, AudienceMCP, now, ErrNotYetValid},
		{"future iat within skew", func() string {
			p := good
			p.Iat, p.Exp = now.Unix()+29, now.Unix()+59
			return mustSign(t, key, p)
		}, AudienceMCP, now, nil},
		{"lifetime too long", func() string {
			p := good
			p.Exp = p.Iat + 61
			return mustSign(t, key, p)
		}, AudienceMCP, now, ErrLifetime},
		{"exp before iat", func() string {
			p := good
			p.Exp = p.Iat - 1
			return mustSign(t, key, p)
		}, AudienceMCP, now, ErrMalformed},
		{"empty sub", func() string {
			p := good
			p.Sub = ""
			return mustSign(t, key, p)
		}, AudienceMCP, now, ErrSubject},
		{"long sub", func() string {
			p := good
			p.Sub = strings.Repeat("a", 256)
			return mustSign(t, key, p)
		}, AudienceMCP, now, ErrSubject},
		{"bad jti", func() string {
			p := good
			p.JTI = "not-a-uuid"
			return mustSign(t, key, p)
		}, AudienceMCP, now, ErrMalformed},
		{"garbage", func() string { return "%%%.%%%" }, AudienceMCP, now, ErrSignature},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Verify(key, c.header(), c.aud, c.at)
			if !errors.Is(err, c.want) {
				t.Fatalf("want %v, got %v", c.want, err)
			}
		})
	}
	if _, err := Verify([]byte("short"), mustSign(t, key, good), AudienceMCP, now); !errors.Is(err, ErrKey) {
		t.Fatalf("short key must fail closed: %v", err)
	}
	if _, err := Sign([]byte("short"), good); !errors.Is(err, ErrKey) {
		t.Fatalf("sign with short key: %v", err)
	}
}

func TestReplay(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	v := NewVerifier(key, AudienceBroker)
	p := payload(now)
	p.Aud = AudienceBroker
	h := mustSign(t, key, p)
	if _, err := v.VerifyAt(h, now); err != nil {
		t.Fatal(err)
	}
	if _, err := v.VerifyAt(h, now.Add(time.Second)); !errors.Is(err, ErrReplay) {
		t.Fatalf("replay must be rejected: %v", err)
	}
	// A fresh jti is fine.
	p.JTI = uuid.NewString()
	if _, err := v.VerifyAt(mustSign(t, key, p), now); err != nil {
		t.Fatal(err)
	}
	// After the replay window the jti is forgotten (the token itself has long expired by then).
	v.seen["x"] = now.Add(-time.Second)
	if !v.remember("x", now) {
		t.Fatal("expired jti entry should be reusable")
	}
}
