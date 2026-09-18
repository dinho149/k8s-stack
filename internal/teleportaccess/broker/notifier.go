package broker

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
)

// Event is what the broker sends to the chat agent's webhook.
type Event struct {
	Type           string        `json:"type"` // request.pending_review | request.resolved
	Request        RequestView   `json:"request"`
	RequesterEmail string        `json:"requester_email,omitempty"`
	Notify         *NotifyTarget `json:"notify,omitempty"`
	ApproverEmails []string      `json:"approver_emails,omitempty"`
	Resolution     *Resolution   `json:"resolution,omitempty"`
}

// NotifyTarget mirrors policy.Notify for the agent.
type NotifyTarget struct {
	Channels         []Channel `json:"channels"`
	MentionApprovers bool      `json:"mention_approvers,omitempty"`
}

// Channel is one chat destination.
type Channel struct {
	Adapter string `json:"adapter"`
	Target  string `json:"target"`
}

// Notifier delivers events to the agent webhook with an HMAC signature and retries.
type Notifier struct {
	URL    string
	Secret string
	Client *http.Client
	Log    *slog.Logger
}

// Sign computes sha256=HMAC(secret, "<ts>.<body>").
func Sign(secret, ts string, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(ts + "."))
	m.Write(body)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

// Send posts the event; it retries with backoff and returns the last error.
func (n *Notifier) Send(ctx context.Context, ev Event) error {
	if n == nil || n.URL == "" {
		return nil
	}
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	id := uuid.NewString()
	var last error
	for attempt := 0; attempt < 5; attempt++ {
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.URL, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Broker-Event-Id", id)
		req.Header.Set("X-Broker-Timestamp", ts)
		req.Header.Set("X-Broker-Signature", Sign(n.Secret, ts, body))
		resp, err := n.client().Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode < 300 {
				return nil
			}
			err = fmt.Errorf("webhook returned %d", resp.StatusCode)
		}
		last = err
		n.Log.Warn("webhook delivery failed", "attempt", attempt+1, "err", err, "event", ev.Type, "request_id", ev.Request.ID)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(1<<attempt) * time.Second):
		}
	}
	return last
}

func (n *Notifier) client() *http.Client {
	if n.Client != nil {
		return n.Client
	}
	return &http.Client{Timeout: 10 * time.Second}
}
