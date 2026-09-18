// Package config holds runtime configuration for teleport-access (env TA_* with optional YAML file).
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"sigs.k8s.io/yaml"
)

// MinSecretLen is the minimum length (bytes) of every shared secret and signing key.
const MinSecretLen = 32

// Config is shared by the mcp, broker and portal subcommands.
type Config struct {
	Teleport TeleportConfig `json:"teleport"`
	MCP      MCPConfig      `json:"mcp"`
	Broker   BrokerConfig   `json:"broker"`
	Portal   PortalConfig   `json:"portal"`
	// IdentitySigningKey (TA_IDENTITY_SIGNING_KEY) verifies the per-turn identity assertions the
	// chat agent signs (X-Teleport-Assertion); shared by the MCP server and the broker.
	IdentitySigningKey string `json:"identity_signing_key"`
	LogLevel           string `json:"log_level"`
	LogText            bool   `json:"log_text"`
}

// TeleportConfig says how to reach the cluster.
type TeleportConfig struct {
	// Addr of the auth or proxy service, e.g. teleport-cluster-auth.teleport.svc.cluster.local:3025
	Addr string `json:"addr"`
	// IdentityFile written by tbot (preferred). Empty => use the local tsh profile (dev only).
	IdentityFile string `json:"identity_file"`
	// Insecure skips proxy TLS verification (local kind only).
	Insecure bool `json:"insecure"`
	// Edition: community | enterprise
	Edition string `json:"edition"`
}

// MCPConfig configures the MCP server.
type MCPConfig struct {
	HTTPAddr    string `json:"http_addr"`    // ":8080"; empty => stdio only
	SharedToken string `json:"shared_token"` // bearer token the agent presents
	// StdioUser is the principal for stdio sessions (defaults to the identity's username).
	StdioUser  string `json:"stdio_user"`
	StdioEmail string `json:"stdio_email"`
	// BrokerURL lets MCP tools show broker predictions (optional).
	BrokerURL   string `json:"broker_url"`
	BrokerToken string `json:"broker_token"`
	PolicyFile  string `json:"policy_file"`
}

// BrokerConfig configures the access broker.
type BrokerConfig struct {
	HTTPAddr        string        `json:"http_addr"` // ":8081"
	APIToken        string        `json:"api_token"`
	PolicyFile      string        `json:"policy_file"`
	Mode            string        `json:"mode"` // watch (default) | poll
	PollInterval    time.Duration `json:"poll_interval"`
	StateFile       string        `json:"state_file"`
	AgentWebhookURL string        `json:"agent_webhook_url"`
	WebhookSecret   string        `json:"webhook_secret"`
	// Approvals: setstate (community default) | review (enterprise SubmitAccessReview) | native (disabled watcher)
	Approvals string `json:"approvals"`
}

// PortalConfig configures the access portal API (the JSON backend of the Dogfood portal's Access pages).
type PortalConfig struct {
	HTTPAddr string `json:"http_addr"` // ":8084"
	// ServiceToken (TA_PORTAL_SERVICE_TOKEN) is the bearer the Backstage backend presents; with it, the
	// X-Dogfood-Subject header is trusted (same model as the lifecycle API).
	ServiceToken string `json:"service_token"`
	// IdentityMapFile (TA_PORTAL_IDENTITY_MAP_FILE) maps portal subjects to Teleport users: JSON {"subject": "user"}.
	IdentityMapFile string `json:"identity_map_file"`
	// IdentityFallback (TA_PORTAL_IDENTITY_FALLBACK): none (default) | username (an unmapped subject that
	// looks like a username is used as the Teleport user; right when Teleport usernames are GitHub logins).
	IdentityFallback string `json:"identity_fallback"`
	// BrokerURL/BrokerToken: approve/deny go through the broker so it stays the single approval authority.
	BrokerURL   string `json:"broker_url"`
	BrokerToken string `json:"broker_token"`
	PolicyFile  string `json:"policy_file"`
}

// Load reads TA_CONFIG_FILE (if set) then overlays TA_* environment variables.
func Load() (*Config, error) {
	c := &Config{
		Teleport: TeleportConfig{Edition: "community"},
		MCP:      MCPConfig{PolicyFile: "/etc/teleport-access/policy.yaml"},
		Broker:   BrokerConfig{HTTPAddr: ":8081", PolicyFile: "/etc/teleport-access/policy.yaml", Mode: "watch", PollInterval: time.Minute, Approvals: "setstate"},
		Portal:   PortalConfig{HTTPAddr: ":8084", IdentityFallback: "none", PolicyFile: "/etc/teleport-access/policy.yaml"},
		LogLevel: "info",
	}
	if f := os.Getenv("TA_CONFIG_FILE"); f != "" {
		b, err := os.ReadFile(filepath.Clean(f)) //nolint:gosec // operator-supplied config path
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", f, err)
		}
		if err := yaml.Unmarshal(b, c); err != nil {
			return nil, fmt.Errorf("parse %s: %w", f, err)
		}
	}
	str := func(k string, dst *string) {
		if v, ok := os.LookupEnv(k); ok {
			*dst = v
		}
	}
	boolean := func(k string, dst *bool) {
		if v, ok := os.LookupEnv(k); ok {
			*dst, _ = strconv.ParseBool(v)
		}
	}
	str("TA_TELEPORT_ADDR", &c.Teleport.Addr)
	str("TA_TELEPORT_IDENTITY_FILE", &c.Teleport.IdentityFile)
	boolean("TA_TELEPORT_INSECURE", &c.Teleport.Insecure)
	str("TA_TELEPORT_EDITION", &c.Teleport.Edition)
	str("TA_MCP_HTTP_ADDR", &c.MCP.HTTPAddr)
	str("TA_MCP_SHARED_TOKEN", &c.MCP.SharedToken)
	str("TA_MCP_STDIO_USER", &c.MCP.StdioUser)
	str("TA_MCP_STDIO_EMAIL", &c.MCP.StdioEmail)
	str("TA_MCP_BROKER_URL", &c.MCP.BrokerURL)
	str("TA_MCP_BROKER_TOKEN", &c.MCP.BrokerToken)
	str("TA_MCP_POLICY_FILE", &c.MCP.PolicyFile)
	str("TA_BROKER_HTTP_ADDR", &c.Broker.HTTPAddr)
	str("TA_BROKER_API_TOKEN", &c.Broker.APIToken)
	str("TA_BROKER_POLICY_FILE", &c.Broker.PolicyFile)
	str("TA_BROKER_MODE", &c.Broker.Mode)
	str("TA_BROKER_STATE_FILE", &c.Broker.StateFile)
	str("TA_BROKER_AGENT_WEBHOOK_URL", &c.Broker.AgentWebhookURL)
	str("TA_BROKER_WEBHOOK_SECRET", &c.Broker.WebhookSecret)
	str("TA_BROKER_APPROVALS", &c.Broker.Approvals)
	if v := os.Getenv("TA_BROKER_POLL_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return nil, fmt.Errorf("TA_BROKER_POLL_INTERVAL: %w", err)
		}
		c.Broker.PollInterval = d
	}
	str("TA_PORTAL_HTTP_ADDR", &c.Portal.HTTPAddr)
	str("TA_PORTAL_SERVICE_TOKEN", &c.Portal.ServiceToken)
	str("TA_PORTAL_IDENTITY_MAP_FILE", &c.Portal.IdentityMapFile)
	str("TA_PORTAL_IDENTITY_FALLBACK", &c.Portal.IdentityFallback)
	str("TA_PORTAL_BROKER_URL", &c.Portal.BrokerURL)
	str("TA_PORTAL_BROKER_TOKEN", &c.Portal.BrokerToken)
	str("TA_PORTAL_POLICY_FILE", &c.Portal.PolicyFile)
	str("TA_IDENTITY_SIGNING_KEY", &c.IdentitySigningKey)
	str("TA_LOG_LEVEL", &c.LogLevel)
	boolean("TA_LOG_TEXT", &c.LogText)
	return c, nil
}

// Validate checks the parts needed by the given subcommand.
func (c *Config) Validate(sub string) error {
	var errs []string
	if c.Teleport.Addr == "" && c.Teleport.IdentityFile != "" {
		errs = append(errs, "teleport.addr (TA_TELEPORT_ADDR) is required with an identity file")
	}
	secret := func(name, env, v string, required bool) {
		switch {
		case v == "" && required:
			errs = append(errs, fmt.Sprintf("%s (%s) is required", name, env))
		case v != "" && len(v) < MinSecretLen:
			errs = append(errs, fmt.Sprintf("%s (%s) must be at least %d bytes", name, env, MinSecretLen))
		}
	}
	mcpHTTP := strings.Contains(sub, "mcp") && c.MCP.HTTPAddr != ""
	broker := strings.Contains(sub, "broker")
	portal := strings.Contains(sub, "portal")
	secret("mcp.shared_token", "TA_MCP_SHARED_TOKEN", c.MCP.SharedToken, mcpHTTP)
	secret("mcp.broker_token", "TA_MCP_BROKER_TOKEN", c.MCP.BrokerToken, false)
	secret("identity_signing_key", "TA_IDENTITY_SIGNING_KEY", c.IdentitySigningKey, mcpHTTP || broker || portal)
	if portal {
		secret("portal.service_token", "TA_PORTAL_SERVICE_TOKEN", c.Portal.ServiceToken, true)
		secret("portal.broker_token", "TA_PORTAL_BROKER_TOKEN", c.Portal.BrokerToken, true)
		if c.Portal.BrokerURL == "" {
			errs = append(errs, "portal.broker_url (TA_PORTAL_BROKER_URL) is required: approvals go through the broker")
		}
		switch c.Portal.IdentityFallback {
		case "none", "username":
		default:
			errs = append(errs, "portal.identity_fallback must be none|username")
		}
		if c.Portal.IdentityMapFile == "" && c.Portal.IdentityFallback == "none" {
			errs = append(errs, "portal: set portal.identity_map_file (TA_PORTAL_IDENTITY_MAP_FILE) or portal.identity_fallback=username, otherwise no subject can be mapped")
		}
	}
	if broker {
		secret("broker.api_token", "TA_BROKER_API_TOKEN", c.Broker.APIToken, true)
		secret("broker.webhook_secret", "TA_BROKER_WEBHOOK_SECRET", c.Broker.WebhookSecret, c.Broker.AgentWebhookURL != "")
		if c.Broker.Mode != "watch" && c.Broker.Mode != "poll" {
			errs = append(errs, "broker.mode must be watch|poll")
		}
		switch c.Broker.Approvals {
		case "setstate", "review", "native":
		default:
			errs = append(errs, "broker.approvals must be setstate|review|native")
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}
