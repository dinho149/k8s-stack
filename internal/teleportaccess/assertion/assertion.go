// Package assertion implements the signed per-turn identity assertion the chat agent presents to
// the MCP server and the access broker. The shared bearer token proves the caller is *an* agent
// process; the assertion proves *which* Teleport user this particular request acts for, and it is
// short-lived and single-use so a captured header cannot be replayed.
//
// Wire format (must match services/access-agent/src/identity/assertion.ts exactly):
//
//	X-Teleport-Assertion: <b64url(payloadJSON)>.<b64url(HMAC-SHA256(key, b64url(payloadJSON)))>
//
// base64url without padding; the HMAC input is the base64url payload string bytes. The payload is
// a JSON object with fields sub (Teleport username, required), email, platform (slack|teams|gchat|
// cli), platform_user_id, aud ("mcp" or "broker"), iat and exp (unix seconds, exp-iat <= 60) and
// jti (UUID string, single use for 5 minutes).
package assertion

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Header carries the assertion.
const Header = "X-Teleport-Assertion"

// Audiences.
const (
	AudienceMCP    = "mcp"
	AudienceBroker = "broker"
)

const (
	// MaxLifetime bounds exp-iat.
	MaxLifetime = 60 * time.Second
	// MaxSkew tolerates clocks that are ahead of ours.
	MaxSkew = 30 * time.Second
	// ReplayWindow is how long a jti stays remembered.
	ReplayWindow = 5 * time.Minute
	// MinKeyLen is the minimum signing key length in bytes.
	MinKeyLen = 32
	// MaxSubjectLen bounds sub.
	MaxSubjectLen = 255
	// maxHeaderLen bounds the header we are willing to parse.
	maxHeaderLen = 8 << 10
	// maxReplayEntries bounds the in-memory replay cache; when full and nothing has expired the
	// verifier fails closed.
	maxReplayEntries = 100_000
)

// Payload is the signed claim set.
type Payload struct {
	Sub            string `json:"sub"`
	Email          string `json:"email,omitempty"`
	Platform       string `json:"platform,omitempty"`
	PlatformUserID string `json:"platform_user_id,omitempty"`
	Aud            string `json:"aud"`
	Iat            int64  `json:"iat"`
	Exp            int64  `json:"exp"`
	JTI            string `json:"jti"`
}

// Verification errors. Callers map every one of them to 401 and log the detail server-side.
var (
	ErrMissing     = errors.New("assertion missing")
	ErrMalformed   = errors.New("assertion malformed")
	ErrSignature   = errors.New("assertion signature invalid")
	ErrAudience    = errors.New("assertion audience mismatch")
	ErrExpired     = errors.New("assertion expired")
	ErrNotYetValid = errors.New("assertion issued in the future")
	ErrLifetime    = errors.New("assertion lifetime too long")
	ErrReplay      = errors.New("assertion already used")
	ErrSubject     = errors.New("assertion subject invalid")
	ErrKey         = errors.New("assertion signing key too short")
)

var enc = base64.RawURLEncoding

// Sign produces a header value for p (used by tests and local tooling; the agent signs in TypeScript).
func Sign(key []byte, p Payload) (string, error) {
	if len(key) < MinKeyLen {
		return "", ErrKey
	}
	b, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	body := enc.EncodeToString(b)
	return body + "." + enc.EncodeToString(mac(key, body)), nil
}

func mac(key []byte, body string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(body))
	return m.Sum(nil)
}

// Verify checks signature, audience, time window, lifetime and subject of header at time now.
// It is stateless: replay protection is provided by Verifier.
func Verify(key []byte, header, aud string, now time.Time) (Payload, error) {
	var p Payload
	if len(key) < MinKeyLen {
		return p, ErrKey
	}
	header = strings.TrimSpace(header)
	if header == "" {
		return p, ErrMissing
	}
	if len(header) > maxHeaderLen {
		return p, ErrMalformed
	}
	body, sig, ok := strings.Cut(header, ".")
	if !ok || body == "" || sig == "" || strings.Contains(sig, ".") {
		return p, ErrMalformed
	}
	sigBytes, err := enc.DecodeString(sig)
	if err != nil {
		return p, ErrSignature
	}
	if !hmac.Equal(sigBytes, mac(key, body)) {
		return p, ErrSignature
	}
	raw, err := enc.DecodeString(body)
	if err != nil {
		return p, ErrMalformed
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, ErrMalformed
	}
	if p.Aud != aud {
		return p, ErrAudience
	}
	if p.Iat <= 0 || p.Exp <= 0 || p.Exp <= p.Iat {
		return p, ErrMalformed
	}
	if time.Duration(p.Exp-p.Iat)*time.Second > MaxLifetime {
		return p, ErrLifetime
	}
	n := now.Unix()
	if n > p.Exp {
		return p, ErrExpired
	}
	if p.Iat > n+int64(MaxSkew/time.Second) {
		return p, ErrNotYetValid
	}
	if p.Sub == "" || len(p.Sub) > MaxSubjectLen || strings.ContainsAny(p.Sub, "\r\n\t\x00") || strings.TrimSpace(p.Sub) != p.Sub {
		return p, ErrSubject
	}
	if _, err := uuid.Parse(p.JTI); err != nil {
		return p, fmt.Errorf("%w: jti", ErrMalformed)
	}
	return p, nil
}

// Verifier verifies assertions for one audience and rejects replayed jti values.
type Verifier struct {
	key []byte
	aud string
	now func() time.Time

	mu   sync.Mutex
	seen map[string]time.Time // jti -> forget-after
}

// NewVerifier builds a verifier; key must be at least MinKeyLen bytes (Verify fails closed otherwise).
func NewVerifier(key []byte, aud string) *Verifier {
	return &Verifier{key: append([]byte(nil), key...), aud: aud, now: time.Now, seen: map[string]time.Time{}}
}

// Verify checks header and records its jti; the same jti is rejected for ReplayWindow.
func (v *Verifier) Verify(header string) (Payload, error) {
	return v.VerifyAt(header, v.now())
}

// VerifyAt is Verify with an explicit clock (tests).
func (v *Verifier) VerifyAt(header string, now time.Time) (Payload, error) {
	p, err := Verify(v.key, header, v.aud, now)
	if err != nil {
		return p, err
	}
	if !v.remember(p.JTI, now) {
		return p, ErrReplay
	}
	return p, nil
}

// remember records jti; false when it was already seen (or the cache is full).
func (v *Verifier) remember(jti string, now time.Time) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if until, ok := v.seen[jti]; ok && now.Before(until) {
		return false
	}
	if len(v.seen) >= maxReplayEntries {
		for k, until := range v.seen {
			if !now.Before(until) {
				delete(v.seen, k)
			}
		}
		if len(v.seen) >= maxReplayEntries {
			return false
		}
	}
	v.seen[jti] = now.Add(ReplayWindow)
	return true
}
