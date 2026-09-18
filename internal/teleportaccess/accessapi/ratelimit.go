package accessapi

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Per-user limits on CreateRequest: a short burst limit and an hourly budget. Each process (MCP
// server, portal API) keeps its own limiter; Teleport's own limits bound the total.
const (
	CreatePerMinute   = 5
	CreateBurst       = 5
	CreatePerHour     = 20
	limiterIdleExpiry = 2 * time.Hour
	maxTrackedUsers   = 10_000
)

// Limiter keeps one pair of token buckets per Teleport user (bounded, expiring).
type Limiter struct {
	mu   sync.Mutex
	now  func() time.Time
	byID map[string]*userLimiter
}

type userLimiter struct {
	minute *rate.Limiter
	hour   *rate.Limiter
	seen   time.Time
}

// NewLimiter returns an empty limiter.
func NewLimiter() *Limiter {
	return &Limiter{now: time.Now, byID: map[string]*userLimiter{}}
}

// Allow reports whether user may create another request now. When tracking is saturated with
// live users it fails closed.
func (p *Limiter) Allow(user string) bool {
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
		l = &userLimiter{minute: rate.NewLimiter(rate.Every(time.Minute/CreatePerMinute), CreateBurst), hour: rate.NewLimiter(rate.Every(time.Hour/CreatePerHour), CreatePerHour)}
		p.byID[user] = l
	}
	l.seen = now
	// Consume from both buckets only when both have a token.
	if l.minute.TokensAt(now) < 1 || l.hour.TokensAt(now) < 1 {
		return false
	}
	return l.minute.AllowN(now, 1) && l.hour.AllowN(now, 1)
}
