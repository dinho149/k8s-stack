// Package broker watches Teleport access requests and decides them per policy: auto-approve
// low-risk requests, hand the rest to human approvers reached through the chat agent.
package broker

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/yeaboi/k8s-stack/internal/teleportaccess/policy"
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
	// OnError is called when the state file cannot be written (main.go wires it to the logger).
	OnError func(error)
}

// NewStore loads the optional state file. A file that exists but cannot be parsed is an error:
// silently starting with an empty store would re-notify (or re-decide) every pending request.
func NewStore(file string) (*Store, error) {
	s := &Store{recs: map[string]*Record{}, file: file}
	if file == "" {
		return s, nil
	}
	b, err := os.ReadFile(filepath.Clean(file)) //nolint:gosec // operator-configured state path
	switch {
	case errors.Is(err, os.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, fmt.Errorf("read state file %s: %w", file, err)
	}
	if len(b) == 0 {
		return s, nil
	}
	if err := json.Unmarshal(b, &s.recs); err != nil {
		return nil, fmt.Errorf("state file %s is corrupt (%v); move it aside to start with an empty store", file, err)
	}
	for id, r := range s.recs {
		if r == nil {
			delete(s.recs, id)
		}
	}
	return s, nil
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

// Prune drops resolved records older than resolvedAfter and marks pending records first seen more
// than pendingAfter ago as expired (Teleport has expired the request by then; the record must not
// linger as "pending" forever).
func (s *Store) Prune(resolvedAfter, pendingAfter time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for id, r := range s.recs {
		switch {
		case !r.ResolvedAt.IsZero() && now.Sub(r.ResolvedAt) > resolvedAfter:
			delete(s.recs, id)
		case r.ResolvedAt.IsZero() && pendingAfter > 0 && now.Sub(r.SeenAt) > pendingAfter:
			r.ResolvedAt = now
			r.Resolution = &Resolution{State: "expired", By: "access-broker", Mode: "external", Reason: "request expired without a decision"}
		}
	}
	s.persist()
}

// persist writes the state atomically: temp file in the same directory, fsync, rename.
func (s *Store) persist() {
	if s.file == "" {
		return
	}
	if err := s.writeAtomic(); err != nil && s.OnError != nil {
		s.OnError(err)
	}
}

func (s *Store) writeAtomic() error {
	dir := filepath.Dir(s.file)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s.recs, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".state-*.json.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmpName, s.file); err != nil {
		cleanup()
		return err
	}
	if d, err := os.Open(filepath.Clean(dir)); err == nil { //nolint:gosec // same directory as the state file
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
