package platform

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func setup(t *testing.T) (*Store, Identity) {
	t.Helper()
	c, e := LoadConfig("../../configs/local.yaml")
	if e != nil {
		t.Fatal(e)
	}
	s, e := OpenStore(filepath.Join(t.TempDir(), "state.db"), c)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	return s, Identity{Subject: "alice", Role: "developer", Teams: []string{"team"}}
}
func create(t *testing.T, s *Store, u Identity) Operation {
	t.Helper()
	op, e := s.Create(u, CreateRequest{ID: "pr-1", Profile: "preview", Team: "team", Image: "ghcr.io/test/app@sha256:" + strings.Repeat("a", 64), Revision: "abcdef1234", Warm: true}, "create-1")
	if e != nil {
		t.Fatal(e)
	}
	return op
}
func TestIdempotencyAndAuthorization(t *testing.T) {
	s, u := setup(t)
	op := create(t, s, u)
	again := create(t, s, u)
	if again.ID != op.ID {
		t.Fatal("duplicate operation")
	}
	_, e := s.Extend(Identity{Subject: "bob", Role: "developer", Teams: []string{"team"}}, "pr-1", "add", 5, 1)
	if !errors.Is(e, ErrForbidden) {
		t.Fatalf("team membership granted write: %v", e)
	}
	if _, e = s.Create(u, CreateRequest{ID: "../bad"}, "bad"); !errors.Is(e, ErrInvalid) {
		t.Fatal(e)
	}
}
func TestExpirySemanticsAndStaleConfirmation(t *testing.T) {
	s, u := setup(t)
	create(t, s, u)
	confirm, e := s.ConfirmDelete(u, "pr-1")
	if e != nil {
		t.Fatal(e)
	}
	env, e := s.Extend(u, "pr-1", "add", 5, 1)
	if e != nil {
		t.Fatal(e)
	}
	if want := s.Now().Add(24*time.Hour + 5*time.Minute); !env.ExpiresAt.Equal(want) {
		t.Fatal(env.ExpiresAt)
	}
	if _, e = s.Delete(u, "pr-1", confirm.ID); !errors.Is(e, ErrConflict) {
		t.Fatal("stale confirmation accepted")
	}
	env, e = s.Extend(u, "pr-1", "from-now", 5, 2)
	if e != nil {
		t.Fatal(e)
	}
	if !env.ExpiresAt.Equal(s.Now().Add(5 * time.Minute)) {
		t.Fatal(env.ExpiresAt)
	}
}
func TestDeletionRaceAndRestart(t *testing.T) {
	s, u := setup(t)
	create(t, s, u)
	now := s.Now().Add(25 * time.Hour)
	s.Now = func() time.Time { return now }
	if e := s.Reconcile(); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Extend(u, "pr-1", "add", 5, 2); !errors.Is(e, ErrConflict) {
		t.Fatal("extension won after deletion started")
	}
	op, _, ok, e := s.Claim()
	if e != nil || !ok || op.Action != "destroy" {
		t.Fatalf("%+v %v", op, e)
	}
	if e = s.Recover(); e != nil {
		t.Fatal(e)
	}
	recovered, _, ok, e := s.Claim()
	if e != nil || !ok || recovered.ID != op.ID || recovered.Attempt != 2 {
		t.Fatal("recovery failed")
	}
}
func TestConcurrentExtensionsOnlyOneGenerationWins(t *testing.T) {
	s, u := setup(t)
	create(t, s, u)
	var wg sync.WaitGroup
	results := make(chan error, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, e := s.Extend(u, "pr-1", "add", 5, 1); results <- e }()
	}
	wg.Wait()
	close(results)
	success := 0
	for e := range results {
		if e == nil {
			success++
		} else if !errors.Is(e, ErrConflict) {
			t.Fatal(e)
		}
	}
	if success != 1 {
		t.Fatal(success)
	}
}
func TestNotificationsAndFailedCleanup(t *testing.T) {
	s, u := setup(t)
	op := create(t, s, u)
	now := s.Now().Add(4 * time.Minute)
	s.Now = func() time.Time { return now }
	_ = s.Reconcile()
	_ = s.Reconcile()
	st, _ := s.Snapshot()
	if len(st.Notifications) != 1 {
		t.Fatal("late notification duplicated")
	}
	_, _, _, _ = s.Claim()
	_ = s.Phase(op.ID, "application-ready")
	_ = s.Finish(op.ID, nil)
	st, _ = s.Snapshot()
	if !st.Notifications["late:pr-1:"+op.ID].Cancelled {
		t.Fatal("late notification not superseded")
	}
	confirm, _ := s.ConfirmDelete(u, "pr-1")
	destroy, _ := s.Delete(u, "pr-1", confirm.ID)
	_, _, _, _ = s.Claim()
	_ = s.Finish(destroy.ID, errors.New("provider unavailable"))
	st, _ = s.Snapshot()
	if st.Environments["pr-1"].Status != "deleting" {
		t.Fatal("failed cleanup no longer protected")
	}
	now = now.Add(time.Hour)
	_ = s.Reconcile()
	st, _ = s.Snapshot()
	if st.Environments["pr-1"].OperationID == destroy.ID {
		t.Fatal("cleanup not retried")
	}
}
func TestDeploymentExtensionDoesNotCancelOperation(t *testing.T) {
	s, u := setup(t)
	op := create(t, s, u)
	_, _, _, _ = s.Claim()
	if _, e := s.Extend(u, "pr-1", "add", 5, 1); e != nil {
		t.Fatal(e)
	}
	if e := s.Finish(op.ID, nil); e != nil {
		t.Fatal(e)
	}
	st, _ := s.Snapshot()
	if st.Environments["pr-1"].Status != "ready" {
		t.Fatal("extension broke deployment")
	}
}
func TestReadOnlyCannotCreate(t *testing.T) {
	s, u := setup(t)
	u.Role = "viewer"
	_, err := s.Create(u, CreateRequest{ID: "pr-1", Image: "ghcr.io/a/b@sha256:" + strings.Repeat("a", 64), Revision: "abcdef123"}, "key")
	if !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
}

func TestReopenDeletedEnvironment(t *testing.T) {
	s, u := setup(t)
	create(t, s, u)
	c, _ := s.ConfirmDelete(u, "pr-1")
	op, _ := s.Delete(u, "pr-1", c.ID)
	_, _, _, _ = s.Claim()
	_ = s.Finish(op.ID, nil)
	next, e := s.Create(u, CreateRequest{ID: "pr-1", Image: "ghcr.io/test/app@sha256:" + strings.Repeat("a", 64), Revision: "abcdef1234"}, "reopen")
	if e != nil || next.Generation != 3 {
		t.Fatalf("reopen failed: %+v %v", next, e)
	}
}

func TestIdempotencySurvivesLaterDeployment(t *testing.T) {
	s, u := setup(t)
	original := create(t, s, u)
	_, err := s.Redeploy(u, "pr-1", "bbbbbbb", "ghcr.io/test/app@sha256:"+strings.Repeat("b", 64), 1)
	if err != nil {
		t.Fatal(err)
	}
	again := create(t, s, u)
	if again.ID != original.ID {
		t.Fatal("retried request did not return original operation")
	}
}
func TestConfirmationExpiresAndIsActorBound(t *testing.T) {
	s, u := setup(t)
	create(t, s, u)
	c, _ := s.ConfirmDelete(u, "pr-1")
	if _, err := s.Delete(Identity{Subject: "other-admin", Role: "admin"}, "pr-1", c.ID); !errors.Is(err, ErrConflict) {
		t.Fatal("confirmation transferred between actors")
	}
	now := s.Now().Add(5 * time.Minute)
	s.Now = func() time.Time { return now }
	if _, err := s.Delete(u, "pr-1", c.ID); !errors.Is(err, ErrConflict) {
		t.Fatal("expired confirmation accepted")
	}
}
func TestClaimSkipsAnEnvironmentAlreadyRunning(t *testing.T) {
	s, u := setup(t)
	create(t, s, u)
	_, _, found, err := s.claimExcept(map[string]bool{"pr-1": true})
	if err != nil || found {
		t.Fatal("same environment can execute concurrently")
	}
}
