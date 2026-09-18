package platform

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Identity struct {
	Subject string   `json:"subject" yaml:"subject"`
	Role    string   `json:"role" yaml:"role"`
	Teams   []string `json:"teams" yaml:"teams"`
}
type Config struct {
	APIVersion string   `yaml:"apiVersion" json:"apiVersion"`
	Name       string   `yaml:"name" json:"name"`
	Provider   string   `yaml:"provider" json:"provider"`
	Profile    string   `yaml:"profile" json:"profile"`
	Domain     string   `yaml:"domain" json:"domain"`
	Region     string   `yaml:"region" json:"region"`
	Project    string   `yaml:"project,omitempty" json:"project,omitempty"`
	Context    string   `yaml:"context" json:"context"`
	StatePath  string   `yaml:"statePath" json:"statePath"`
	Listen     string   `yaml:"listen" json:"listen"`
	Repository string   `yaml:"repository" json:"repository"`
	Components []string `yaml:"components" json:"components"`
	Lifecycle  struct {
		TTL              time.Duration `yaml:"ttl" json:"ttl"`
		MaxTTL           time.Duration `yaml:"maxTTL" json:"maxTTL"`
		WarmTarget       time.Duration `yaml:"warmTarget" json:"warmTarget"`
		OperationTimeout time.Duration `yaml:"operationTimeout" json:"operationTimeout"`
		MaxPreviews      int           `yaml:"maxPreviews" json:"maxPreviews"`
	} `yaml:"lifecycle" json:"lifecycle"`
	Agent struct {
		Provider string `yaml:"provider" json:"provider"`
		Bedrock  struct {
			Region string `yaml:"region" json:"region"`
			Model  string `yaml:"model" json:"model"`
		} `yaml:"bedrock" json:"bedrock"`
		Vertex struct {
			Project string `yaml:"project" json:"project"`
			Region  string `yaml:"region" json:"region"`
			Model   string `yaml:"model" json:"model"`
		} `yaml:"vertex" json:"vertex"`
	} `yaml:"agent" json:"agent"`
	Auth struct {
		Issuer   string     `yaml:"issuer" json:"issuer"`
		ClientID string     `yaml:"clientId" json:"clientId"`
		Users    []Identity `yaml:"users" json:"users"`
	} `yaml:"auth" json:"auth"`
}

var nameRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
var revisionRE = regexp.MustCompile(`^[a-f0-9]{7,64}$`)
var imageRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9./_:-]+@sha256:[a-f0-9]{64}$`)

func LoadConfig(path string) (Config, error) {
	var c Config
	b, e := os.ReadFile(path)
	if e != nil {
		return c, e
	}
	d := yaml.NewDecoder(bytes.NewReader(b))
	d.KnownFields(true)
	if e = d.Decode(&c); e != nil {
		return c, e
	}
	return c, c.Validate()
}
func (c Config) Validate() error {
	if c.APIVersion != "stack.platform/v1alpha1" {
		return errors.New("unsupported apiVersion")
	}
	if !nameRE.MatchString(c.Name) {
		return errors.New("name must be a lowercase DNS label, at most 40 characters")
	}
	if c.Provider != "kind" && c.Provider != "aws" && c.Provider != "gcp" && c.Provider != "existing" {
		return errors.New("provider must be kind, aws, gcp or existing")
	}
	if c.Profile != "local" && c.Profile != "dev" && c.Profile != "staging" && c.Profile != "prod" {
		return errors.New("invalid profile")
	}
	if strings.ContainsAny(c.Domain, " /\n\r") || c.Domain == "" {
		return errors.New("domain required")
	}
	if c.StatePath == "" || c.Context == "" || c.Listen == "" {
		return errors.New("statePath, context and listen required")
	}
	if c.Lifecycle.TTL <= 0 || c.Lifecycle.MaxTTL < c.Lifecycle.TTL || c.Lifecycle.WarmTarget <= 0 || c.Lifecycle.OperationTimeout <= 0 || c.Lifecycle.MaxPreviews < 1 {
		return errors.New("invalid lifecycle limits")
	}
	if c.Agent.Provider != "bedrock" && c.Agent.Provider != "vertex" {
		return errors.New("agent.provider must be bedrock or vertex; no implicit fallback")
	}
	if c.Agent.Provider == "bedrock" && (c.Agent.Bedrock.Region == "" || c.Agent.Bedrock.Model == "") {
		return errors.New("bedrock region and model required")
	}
	if c.Agent.Provider == "vertex" && (c.Agent.Vertex.Project == "" || c.Agent.Vertex.Region == "" || c.Agent.Vertex.Model == "") {
		return errors.New("vertex project, region and model required")
	}
	seen := map[string]bool{}
	for _, u := range c.Auth.Users {
		if u.Subject == "" || seen[u.Subject] {
			return errors.New("auth subjects must be unique and nonempty")
		}
		seen[u.Subject] = true
		if u.Role != "viewer" && u.Role != "developer" && u.Role != "admin" {
			return fmt.Errorf("invalid role for %s", u.Subject)
		}
	}
	if c.Profile != "local" && (c.Auth.Issuer == "" || c.Auth.ClientID == "") {
		return errors.New("OIDC issuer/clientId required outside local profile")
	}
	return nil
}
func (c Config) Identity(subject string) (Identity, bool) {
	for _, u := range c.Auth.Users {
		if u.Subject == subject {
			return u, true
		}
	}
	return Identity{}, false
}
