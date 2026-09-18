package platform

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"time"

	bolt "go.etcd.io/bbolt"
)

var ErrForbidden = errors.New("forbidden")
var ErrNotFound = errors.New("not found")
var ErrConflict = errors.New("conflict")
var ErrInvalid = errors.New("invalid request")

type Environment struct {
	ID          string     `json:"id"`
	Owner       string     `json:"owner"`
	Team        string     `json:"team"`
	Profile     string     `json:"profile"`
	Provider    string     `json:"provider"`
	Revision    string     `json:"revision"`
	Image       string     `json:"image"`
	Status      string     `json:"status"`
	URL         string     `json:"url"`
	CreatedAt   time.Time  `json:"createdAt"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
	Generation  int        `json:"generation"`
	OperationID string     `json:"operationId"`
}
type Operation struct {
	ID            string               `json:"id"`
	EnvironmentID string               `json:"environmentId"`
	Actor         string               `json:"actor"`
	Action        string               `json:"action"`
	Status        string               `json:"status"`
	Phase         string               `json:"phase"`
	Error         string               `json:"error,omitempty"`
	RequestedAt   time.Time            `json:"requestedAt"`
	StartedAt     *time.Time           `json:"startedAt,omitempty"`
	FinishedAt    *time.Time           `json:"finishedAt,omitempty"`
	Timings       map[string]time.Time `json:"timings"`
	Generation    int                  `json:"generation"`
	Attempt       int                  `json:"attempt"`
	Warm          bool                 `json:"warm"`
}
type Audit struct {
	At      time.Time `json:"at"`
	Actor   string    `json:"actor"`
	Action  string    `json:"action"`
	Target  string    `json:"target"`
	Outcome string    `json:"outcome"`
}
type Notification struct {
	ID            string    `json:"id"`
	Kind          string    `json:"kind"`
	Owner         string    `json:"owner"`
	EnvironmentID string    `json:"environmentId"`
	OperationID   string    `json:"operationId,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
	NotBefore     time.Time `json:"notBefore"`
	Attempts      int       `json:"attempts"`
	Delivered     bool      `json:"delivered"`
	Cancelled     bool      `json:"cancelled"`
}
type Confirmation struct {
	ID            string    `json:"id"`
	Actor         string    `json:"actor"`
	EnvironmentID string    `json:"environmentId"`
	Generation    int       `json:"generation"`
	ExpiresAt     time.Time `json:"expiresAt"`
}
type Link struct {
	Channel     string `json:"channel"`
	Tenant      string `json:"tenant"`
	User        string `json:"user"`
	Subject     string `json:"subject"`
	Destination string `json:"destination"`
}
type LinkCode struct {
	Subject   string    `json:"subject"`
	ExpiresAt time.Time `json:"expiresAt"`
}
type State struct {
	Environments        map[string]Environment  `json:"environments"`
	Operations          map[string]Operation    `json:"operations"`
	IdempotencyPayloads map[string]string       `json:"idempotencyPayloads"`
	Idempotency         map[string]string       `json:"idempotency"`
	Confirmations       map[string]Confirmation `json:"confirmations"`
	Notifications       map[string]Notification `json:"notifications"`
	Links               map[string]Link         `json:"links"`
	LinkCodes           map[string]LinkCode     `json:"linkCodes"`
	Audit               []Audit                 `json:"audit"`
}
type Store struct {
	db     *bolt.DB
	Config Config
	Now    func() time.Time
}

func OpenStore(path string, c Config) (*Store, error) {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	db, e := bolt.Open(path, 0600, &bolt.Options{Timeout: time.Second})
	if e != nil {
		return nil, e
	}
	return &Store{db: db, Config: c, Now: func() time.Time { return time.Now().UTC() }}, nil
}
func (s *Store) Close() error { return s.db.Close() }
func newState() State {
	return State{Environments: map[string]Environment{}, Operations: map[string]Operation{}, Idempotency: map[string]string{}, IdempotencyPayloads: map[string]string{}, Confirmations: map[string]Confirmation{}, Notifications: map[string]Notification{}, Links: map[string]Link{}, LinkCodes: map[string]LinkCode{}}
}
func (s *Store) transaction(fn func(*State) error) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b, e := tx.CreateBucketIfNotExists([]byte("platform-v1"))
		if e != nil {
			return e
		}
		st := newState()
		if raw := b.Get([]byte("state")); raw != nil {
			if e = json.Unmarshal(raw, &st); e != nil {
				return e
			}
		}
		if e = fn(&st); e != nil {
			return e
		}
		raw, e := json.Marshal(st)
		if e != nil {
			return e
		}
		return b.Put([]byte("state"), raw)
	})
}
func (s *Store) Snapshot() (State, error) {
	st := newState()
	e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("platform-v1"))
		if b == nil {
			return nil
		}
		raw := b.Get([]byte("state"))
		if raw == nil {
			return nil
		}
		return json.Unmarshal(raw, &st)
	})
	return st, e
}
func id() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func allowed(u Identity, e Environment) bool {
	if u.Role == "admin" || e.Owner == u.Subject {
		return true
	}
	for _, t := range u.Teams {
		if e.Team != "" && t == e.Team {
			return true
		}
	}
	return false
}
func canWrite(u Identity, e Environment) bool {
	return u.Role == "admin" || (u.Role == "developer" && u.Subject == e.Owner && e.Profile == "preview")
}
func audit(st *State, now time.Time, u, action, target, outcome string) {
	st.Audit = append(st.Audit, Audit{now, u, action, target, outcome})
}
func notify(st *State, now time.Time, kind string, e Environment, op string) {
	key := kind + ":" + e.ID + ":" + op
	if _, ok := st.Notifications[key]; !ok {
		st.Notifications[key] = Notification{ID: key, Kind: kind, Owner: e.Owner, EnvironmentID: e.ID, OperationID: op, CreatedAt: now, NotBefore: now}
	}
}
func cancelNotices(st *State, env string) {
	for k, n := range st.Notifications {
		if n.EnvironmentID == env && !n.Delivered {
			n.Cancelled = true
			st.Notifications[k] = n
		}
	}
}
func queue(st *State, now time.Time, u, action string, e *Environment, warm bool) Operation {
	cancelNotices(st, e.ID)
	op := Operation{ID: id(), EnvironmentID: e.ID, Actor: u, Action: action, Status: "queued", Phase: "queued", RequestedAt: now, Generation: e.Generation, Timings: map[string]time.Time{}, Warm: warm}
	e.OperationID = op.ID
	st.Operations[op.ID] = op
	st.Environments[e.ID] = *e
	audit(st, now, u, action, e.ID, "queued")
	return op
}

type CreateRequest struct {
	ID       string `json:"id"`
	Team     string `json:"team"`
	Profile  string `json:"profile"`
	Revision string `json:"revision"`
	Image    string `json:"image"`
	Warm     bool   `json:"warm"`
}

func (s *Store) Create(u Identity, r CreateRequest, key string) (Operation, error) {
	var out Operation
	if !nameRE.MatchString(r.ID) || !revisionRE.MatchString(r.Revision) || !imageRE.MatchString(r.Image) || key == "" || len(key) > 200 {
		return out, ErrInvalid
	}
	if r.Profile == "" {
		r.Profile = "preview"
	}
	if r.Profile != "preview" {
		return out, errors.New("persistent environments are managed through infrastructure GitOps; preview API cannot create them")
	}
	if u.Role != "developer" && u.Role != "admin" {
		return out, ErrForbidden
	}
	teamOK := r.Team == "" || u.Role == "admin"
	for _, t := range u.Teams {
		if t == r.Team {
			teamOK = true
		}
	}
	if !teamOK {
		return out, ErrForbidden
	}
	err := s.transaction(func(st *State) error {
		ik := u.Subject + ":create:" + key
		payload, _ := json.Marshal(r)
		if opID, ok := st.Idempotency[ik]; ok {
			out = st.Operations[opID]
			if original, ok := st.IdempotencyPayloads[ik]; ok && original != string(payload) {
				return ErrConflict
			}
			return nil
		}
		generation := 1
		if previous, ok := st.Environments[r.ID]; ok {
			if previous.Status != "deleted" {
				return ErrConflict
			}
			if previous.Owner != u.Subject && u.Role != "admin" {
				return ErrForbidden
			}
			generation = previous.Generation + 1
		}
		count := 0
		for _, e := range st.Environments {
			if e.Status != "deleted" {
				count++
			}
		}
		if count >= s.Config.Lifecycle.MaxPreviews {
			return errors.New("preview quota exceeded")
		}
		now := s.Now()
		expiry := now.Add(s.Config.Lifecycle.TTL)
		env := Environment{ID: r.ID, Owner: u.Subject, Team: r.Team, Profile: r.Profile, Provider: s.Config.Provider, Revision: r.Revision, Image: r.Image, Status: "pending", CreatedAt: now, ExpiresAt: &expiry, Generation: generation, URL: "https://" + r.ID + "." + s.Config.Domain}
		if s.Config.Profile == "local" {
			env.URL = "http://" + r.ID + "." + s.Config.Domain + ":18080"
		}
		out = queue(st, now, u.Subject, "deploy", &env, r.Warm)
		st.Idempotency[ik] = out.ID
		st.IdempotencyPayloads[ik] = string(payload)
		return nil
	})
	return out, err
}
func (s *Store) Extend(u Identity, envID, mode string, minutes int, expected int) (Environment, error) {
	var out Environment
	if minutes < 1 || minutes > 10080 || (mode != "add" && mode != "from-now") {
		return out, ErrInvalid
	}
	err := s.transaction(func(st *State) error {
		e, ok := st.Environments[envID]
		if !ok {
			return ErrNotFound
		}
		if !canWrite(u, e) {
			return ErrForbidden
		}
		if e.Profile != "preview" || e.ExpiresAt == nil || e.Status == "deleting" || e.Status == "deleted" || e.Generation != expected {
			return ErrConflict
		}
		now := s.Now()
		next := now.Add(time.Duration(minutes) * time.Minute)
		if mode == "add" {
			next = e.ExpiresAt.Add(time.Duration(minutes) * time.Minute)
		}
		if next.After(e.CreatedAt.Add(s.Config.Lifecycle.MaxTTL)) || !next.After(now) {
			return errors.New("expiry outside permitted lifetime")
		}
		e.ExpiresAt = &next
		e.Generation++
		st.Environments[e.ID] = e
		// Expiry changes must not invalidate an in-flight deployment generation.
		if op, ok := st.Operations[e.OperationID]; ok && (op.Status == "queued" || op.Status == "running") {
			op.Generation = e.Generation
			st.Operations[op.ID] = op
		}
		for k, n := range st.Notifications {
			if n.EnvironmentID == e.ID && n.Kind == "expiring" && !n.Delivered {
				n.Cancelled = true
				st.Notifications[k] = n
			}
		}
		audit(st, now, u.Subject, "extend", e.ID, next.Format(time.RFC3339))
		out = e
		return nil
	})
	return out, err
}
func (s *Store) ConfirmDelete(u Identity, envID string) (Confirmation, error) {
	var out Confirmation
	err := s.transaction(func(st *State) error {
		e, ok := st.Environments[envID]
		if !ok {
			return ErrNotFound
		}
		if !canWrite(u, e) {
			return ErrForbidden
		}
		if e.Profile != "preview" || e.Status == "deleted" {
			return ErrConflict
		}
		out = Confirmation{id(), u.Subject, e.ID, e.Generation, s.Now().Add(5 * time.Minute)}
		st.Confirmations[out.ID] = out
		return nil
	})
	return out, err
}
func (s *Store) Delete(u Identity, envID, confirmation string) (Operation, error) {
	var out Operation
	err := s.transaction(func(st *State) error {
		e, ok := st.Environments[envID]
		if !ok {
			return ErrNotFound
		}
		if !canWrite(u, e) {
			return ErrForbidden
		}
		c, ok := st.Confirmations[confirmation]
		if !ok || c.Actor != u.Subject || c.EnvironmentID != e.ID || c.Generation != e.Generation || !s.Now().Before(c.ExpiresAt) || e.Profile != "preview" {
			return ErrConflict
		}
		delete(st.Confirmations, confirmation)
		supersede(st, e.OperationID, s.Now())
		e.Generation++
		e.Status = "deleting"
		out = queue(st, s.Now(), u.Subject, "destroy", &e, false)
		return nil
	})
	return out, err
}
func supersede(st *State, opID string, now time.Time) {
	if op, ok := st.Operations[opID]; ok && (op.Status == "queued" || op.Status == "running") {
		op.Status = "superseded"
		op.FinishedAt = &now
		st.Operations[op.ID] = op
	}
}
func (s *Store) Redeploy(u Identity, envID, revision, image string, expected int) (Operation, error) {
	var out Operation
	if !revisionRE.MatchString(revision) || !imageRE.MatchString(image) {
		return out, ErrInvalid
	}
	err := s.transaction(func(st *State) error {
		e, ok := st.Environments[envID]
		if !ok {
			return ErrNotFound
		}
		if !canWrite(u, e) {
			return ErrForbidden
		}
		if e.Generation != expected || e.Status == "deleting" || e.Status == "deleted" {
			return ErrConflict
		}
		supersede(st, e.OperationID, s.Now())
		e.Revision = revision
		e.Image = image
		e.Generation++
		e.Status = "pending"
		out = queue(st, s.Now(), u.Subject, "deploy", &e, true)
		return nil
	})
	return out, err
}
func (s *Store) Reconcile() error {
	return s.transaction(func(st *State) error {
		now := s.Now()
		for key, c := range st.Confirmations {
			if !now.Before(c.ExpiresAt) {
				delete(st.Confirmations, key)
			}
		}
		for key, c := range st.LinkCodes {
			if !now.Before(c.ExpiresAt) {
				delete(st.LinkCodes, key)
			}
		}
		for _, e := range st.Environments {
			if e.Profile != "preview" || e.Status == "deleted" {
				continue
			}
			op := st.Operations[e.OperationID]
			if e.Status == "deleting" {
				if op.Status == "failed" && op.FinishedAt != nil && now.Sub(*op.FinishedAt) >= time.Hour {
					e.Generation++
					queue(st, now, "system", "destroy", &e, false)
				}
				continue
			}
			if e.ExpiresAt != nil && !now.Before(*e.ExpiresAt) {
				supersede(st, e.OperationID, now)
				e.Generation++
				e.Status = "deleting"
				queue(st, now, "system", "destroy", &e, false)
				continue
			}
			if e.ExpiresAt != nil && e.ExpiresAt.Sub(now) <= 5*time.Minute {
				notify(st, now, "expiring", e, e.ExpiresAt.Format(time.RFC3339))
			}
			if op.Warm && (op.Status == "queued" || op.Status == "running") && now.Sub(op.RequestedAt) > s.Config.Lifecycle.WarmTarget {
				notify(st, now, "late", e, op.ID)
			}
		}
		return nil
	})
}
func (s *Store) Recover() error {
	return s.transaction(func(st *State) error {
		for k, op := range st.Operations {
			if op.Status == "running" {
				op.Status = "queued"
				op.Phase = "recovering"
				st.Operations[k] = op
			}
		}
		return nil
	})
}
func (s *Store) Claim() (Operation, Environment, bool, error) { return s.claimExcept(nil) }
func (s *Store) claimExcept(active map[string]bool) (Operation, Environment, bool, error) {
	var out Operation
	var env Environment
	found := false
	err := s.transaction(func(st *State) error {
		keys := make([]string, 0, len(st.Operations))
		for k := range st.Operations {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			return st.Operations[keys[i]].RequestedAt.Before(st.Operations[keys[j]].RequestedAt)
		})
		for _, k := range keys {
			op := st.Operations[k]
			if op.Status != "queued" || active[op.EnvironmentID] {
				continue
			}
			e := st.Environments[op.EnvironmentID]
			if e.OperationID != op.ID {
				continue
			}
			now := s.Now()
			if op.StartedAt == nil {
				op.StartedAt = &now
			}
			op.Status = "running"
			op.Attempt++
			op.Phase = "provisioning"
			st.Operations[k] = op
			out = op
			env = e
			found = true
			break
		}
		return nil
	})
	return out, env, found, err
}
func (s *Store) Phase(opID, phase string) error {
	return s.transaction(func(st *State) error {
		op, ok := st.Operations[opID]
		if !ok {
			return ErrNotFound
		}
		if op.Status != "running" {
			return ErrConflict
		}
		op.Phase = phase
		op.Timings[phase] = s.Now()
		st.Operations[opID] = op
		return nil
	})
}
func (s *Store) Finish(opID string, runErr error) error {
	return s.transaction(func(st *State) error {
		op, ok := st.Operations[opID]
		if !ok {
			return ErrNotFound
		}
		if op.Status != "running" {
			return nil
		}
		e := st.Environments[op.EnvironmentID]
		if e.OperationID != op.ID {
			return nil
		}
		now := s.Now()
		op.FinishedAt = &now
		cancelNotices(st, e.ID)
		if runErr != nil {
			op.Status = "failed"
			op.Error = runErr.Error()
			if op.Action != "destroy" {
				e.Status = "failed"
			}
			kind := "failed"
			if op.Action == "destroy" {
				kind = "cleanup-failed"
			}
			notify(st, now, kind, e, op.ID)
		} else {
			op.Status = "succeeded"
			op.Phase = "ready"
			e.Status = "ready"
			kind := "ready"
			if op.Action == "destroy" {
				e.Status = "deleted"
				op.Phase = "deleted"
				kind = "deleted"
			}
			notify(st, now, kind, e, op.ID)
		}
		st.Operations[op.ID] = op
		st.Environments[e.ID] = e
		audit(st, now, op.Actor, op.Action, e.ID, op.Status)
		return nil
	})
}
