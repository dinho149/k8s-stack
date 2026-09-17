// Package broker watches Teleport access requests and decides them per policy: auto-approve
// low-risk requests, hand the rest to human approvers reached through the chat agent.
package broker

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/dinho/k8s-teleport/services/teleport-access/internal/policy"
)

// Record is what the broker remembers about a request (Teleport stays the source of truth).
type Record struct {
	ID         string          `json:"id"`
	User       string          `json:"user"`
	Roles      []string        `json:"roles"`
	Decision   policy.Decision `json:"decision"`
	SeenAt     time.Time       `json:"seen_at"`
	NotifiedAt time.Time       `json:"notified_at,omitempty"`
	ResolvedAt time.Time       `json:"resolved_at,omitempty"`
	Resolution *Resolution     `json:"resolution,omitempty"`
}

// Resolution records who decided and how.
type Resolution struct {
	State  string `json:"state"` // approved | denied | expired
	By     string `json:"by"`
	Mode   string `json:"mode"` // auto | chat | external
	Reason string `json:"reason"`
}

// Store persists Records; memory by default, JSON file when a path is given.
type Store struct {
	mu   sync.Mutex
	recs map[string]*Record
	file string
}

// NewStore loads the optional state file.
func NewStore(file string) *Store {
	s := &Store{recs: map[string]*Record{}, file: file}
	if file != "" {
		if b, err := os.ReadFile(file); err == nil {
			_ = json.Unmarshal(b, &s.recs)
		}
	}
	return s
}

func (s *Store) Get(id string) (*Record, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.recs[id]
	if !ok {
		return nil, false
	}
	cp := *r
	return &cp, true
}

func (s *Store) Put(r *Record) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *r
	s.recs[r.ID] = &cp
	s.persist()
}

func (s *Store) Pending() []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Record
	for _, r := range s.recs {
		if r.ResolvedAt.IsZero() {
			out = append(out, *r)
		}
	}
	return out
}

// Prune drops resolved records older than d.
func (s *Store) Prune(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, r := range s.recs {
		if !r.ResolvedAt.IsZero() && time.Since(r.ResolvedAt) > d {
			delete(s.recs, id)
		}
	}
	s.persist()
}

func (s *Store) persist() {
	if s.file == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(s.file), 0o755)
	b, err := json.MarshalIndent(s.recs, "", "  ")
	if err == nil {
		_ = os.WriteFile(s.file, b, 0o600)
	}
}
