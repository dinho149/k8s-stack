package broker

import (
	"context"
	"errors"
	"time"

	"github.com/gravitational/teleport/api/types"
)

// RunWatcher streams access request events into the service, reconnecting with backoff and
// reconciling pending requests on every (re)connect. When poll is true it polls instead.
func (s *Service) RunWatcher(ctx context.Context, poll bool, pollInterval time.Duration) error {
	if poll {
		return s.runPoll(ctx, pollInterval)
	}
	backoff := time.Second
	for {
		err := s.watchOnce(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.Log.Warn("watcher ended; reconnecting", "err", err, "backoff", backoff)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (s *Service) watchOnce(ctx context.Context) error {
	w, err := s.API.NewWatcher(ctx, types.Watch{Kinds: []types.WatchKind{{Kind: types.KindAccessRequest}}})
	if err != nil {
		return err
	}
	defer w.Close()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-w.Done():
			if err := w.Error(); err != nil {
				return err
			}
			return errors.New("watcher closed")
		case ev := <-w.Events():
			switch ev.Type {
			case types.OpInit:
				s.Log.Info("access request watcher connected")
				if err := s.Reconcile(ctx); err != nil {
					s.Log.Error("reconcile", "err", err)
				}
			case types.OpPut:
				if r, ok := ev.Resource.(types.AccessRequest); ok {
					if err := s.Handle(ctx, r); err != nil {
						s.Log.Error("handle request", "request_id", r.GetName(), "err", err)
					}
				}
			}
		}
	}
}

func (s *Service) runPoll(ctx context.Context, every time.Duration) error {
	if every <= 0 {
		every = time.Minute
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := s.Reconcile(ctx); err != nil {
			s.Log.Error("poll", "err", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}
