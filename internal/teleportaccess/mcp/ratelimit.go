package mcpserver

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Per-principal limits on create_access_request: a short burst limit and an hourly budget.
const (
	createPerMinute   = 5
	createBurst       = 5
	createPerHour     = 20
	limiterIdleExpiry = 2 * time.Hour
	maxTrackedUsers   = 10_000
)

// principalLimiters keeps one pair of token buckets per Teleport user (bounded, expiring).
type principalLimiters struct {
	mu   sync.Mutex
	now  func() time.Time
	byID map[string]*userLimiter
}

type userLimiter struct {
	minute *rate.Limiter
	hour   *rate.Limiter
	seen   time.Time
}

func newPrincipalLimiters() *principalLimiters {
	return &principalLimiters{now: time.Now, byID: map[string]*userLimiter{}}
}

// allow reports whether user may create another request now. When tracking is saturated with
// live users it fails closed.
func (p *principalLimiters) allow(user string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	l, ok := p.byID[user]
	if !ok {
		if len(p.byID) >= maxTrackedUsers {
			for k, v := range p.byID {
				if now.Sub(v.seen) > limiterIdleExpiry {
					delete(p.byID, k)
				}
			}
			if len(p.byID) >= maxTrackedUsers {
				return false
			}
		}
		l = &userLimiter{minute: rate.NewLimiter(rate.Every(time.Minute/createPerMinute), createBurst), hour: rate.NewLimiter(rate.Every(time.Hour/createPerHour), createPerHour)}
		p.byID[user] = l
	}
	l.seen = now
	// Consume from both buckets only when both have a token.
	if l.minute.TokensAt(now) < 1 || l.hour.TokensAt(now) < 1 {
		return false
	}
	return l.minute.AllowN(now, 1) && l.hour.AllowN(now, 1)
}
