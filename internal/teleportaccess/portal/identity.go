// Package portal is the JSON API behind the Dogfood portal's Access pages (teleport-access portal).
//
// Trust model: the Backstage backend authenticates the person, maps them to a subject and calls this
// API with a service bearer token plus X-Dogfood-Subject (the same contract as the lifecycle API).
// The subject is mapped to a Teleport user, which must exist and must not be a bot; every read and
// every request creation then goes through the shared accessapi.Service with that principal. Approve
// and deny are forwarded to the access broker with a signed identity assertion (platform "portal"),
// so the broker remains the single authority that verifies approver roles and blocks self-approval.
// The API is meant to be reachable only from the Backstage backend (NetworkPolicy / port-forward).
package portal

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Fallback modes for subjects absent from the identity map.
const (
	FallbackNone     = "none"
	FallbackUsername = "username"
)

// usernameRE is the shape of a Teleport username that is also a GitHub login (case-insensitive,
// no whitespace); it bounds what an unmapped subject may become.
var usernameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// Mapper resolves portal subjects to Teleport users.
type Mapper struct {
	identities map[string]string
	fallback   string
}

// NewMapper builds a mapper from an explicit map and a fallback mode.
func NewMapper(identities map[string]string, fallback string) *Mapper {
	m := &Mapper{identities: map[string]string{}, fallback: fallback}
	for k, v := range identities {
		m.identities[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return m
}

// LoadMapper reads a JSON object {"subject": "teleport-user"} (file may be empty when fallback is username).
func LoadMapper(file, fallback string) (*Mapper, error) {
	identities := map[string]string{}
	if file != "" {
		b, err := os.ReadFile(filepath.Clean(file)) //nolint:gosec // operator-supplied config path
		if err != nil {
			return nil, fmt.Errorf("read identity map %s: %w", file, err)
		}
		if len(strings.TrimSpace(string(b))) > 0 {
			if err := json.Unmarshal(b, &identities); err != nil {
				return nil, fmt.Errorf("parse identity map %s: %w", file, err)
			}
		}
	}
	for k, v := range identities {
		if k == "" || v == "" || !usernameRE.MatchString(v) {
			return nil, fmt.Errorf("identity map %s: invalid entry %q -> %q", file, k, v)
		}
	}
	return NewMapper(identities, fallback), nil
}

// Resolve returns the Teleport user for subject. An explicit mapping wins; otherwise, with the
// username fallback, a subject shaped like a username is used as-is. Anything else is unmapped.
func (m *Mapper) Resolve(subject string) (string, bool) {
	subject = strings.TrimSpace(subject)
	if subject == "" {
		return "", false
	}
	if u, ok := m.identities[subject]; ok {
		return u, true
	}
	if m.fallback == FallbackUsername && usernameRE.MatchString(subject) {
		return subject, true
	}
	return "", false
}
