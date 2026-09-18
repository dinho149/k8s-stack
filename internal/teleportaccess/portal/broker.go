package portal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/yeaboi/k8s-stack/internal/teleportaccess/assertion"
)

// PlatformName is the assertion platform the portal signs with; the broker records it as the
// decision channel (access-broker/channel) and mode (access-broker/mode: portal).
const PlatformName = "portal"

// assertionTTL is well inside assertion.MaxLifetime.
const assertionTTL = 45 * time.Second

// BrokerClient calls the access broker's approve/deny endpoints on behalf of a verified approver.
type BrokerClient struct {
	URL   string
	Token string
	Key   []byte
	HTTP  *http.Client
	Now   func() time.Time
}

// NewBrokerClient builds a client with sane timeouts.
func NewBrokerClient(url, token string, key []byte) *BrokerClient {
	return &BrokerClient{URL: strings.TrimRight(url, "/"), Token: token, Key: key, HTTP: &http.Client{Timeout: 20 * time.Second}, Now: time.Now}
}

// BrokerError is a non-2xx answer from the broker (Code/Message from its JSON body when present).
type BrokerError struct {
	Status  int
	Code    string
	Message string
}

func (e *BrokerError) Error() string {
	return fmt.Sprintf("broker: %d %s: %s", e.Status, e.Code, e.Message)
}

// Approver is the person deciding; Subject is the portal subject they signed in as.
type Approver struct {
	TeleportUser string
	Email        string
	Subject      string
}

// Decide approves (approve=true) or denies request id as by. The approver identity travels only in
// the signed X-Teleport-Assertion header; the body carries the reason alone.
func (c *BrokerClient) Decide(ctx context.Context, id string, approve bool, by Approver, reason string) error {
	if c == nil || c.URL == "" {
		return &BrokerError{Status: http.StatusBadGateway, Code: "broker_unavailable", Message: "no broker configured"}
	}
	now := c.Now().Unix()
	hdr, err := assertion.Sign(c.Key, assertion.Payload{Sub: by.TeleportUser, Email: by.Email, Platform: PlatformName, PlatformUserID: by.Subject,
		Aud: assertion.AudienceBroker, Iat: now, Exp: now + int64(assertionTTL/time.Second), JTI: uuid.NewString()})
	if err != nil {
		return fmt.Errorf("sign assertion: %w", err)
	}
	verb := "deny"
	if approve {
		verb = "approve"
	}
	body, _ := json.Marshal(map[string]string{"reason": reason})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/v1/requests/%s/%s", c.URL, id, verb), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set(assertion.Header, hdr)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return &BrokerError{Status: http.StatusBadGateway, Code: "broker_unavailable", Message: "the access broker did not answer"}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return nil
	}
	var e struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&e)
	if resp.StatusCode == http.StatusUnauthorized {
		// The broker rejected OUR credentials (bearer or signing key): a deployment fault, never the person's.
		return &BrokerError{Status: http.StatusBadGateway, Code: "broker_auth", Message: "the access broker rejected the portal's credentials"}
	}
	if e.Code == "" {
		e.Code = "broker_error"
	}
	if e.Error == "" {
		e.Error = "the access broker refused the decision"
	}
	return &BrokerError{Status: resp.StatusCode, Code: e.Code, Message: e.Error}
}

// AsBrokerError unwraps a BrokerError.
func AsBrokerError(err error) (*BrokerError, bool) {
	var be *BrokerError
	if errors.As(err, &be) {
		return be, true
	}
	return nil, false
}
