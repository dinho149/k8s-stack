package teleport

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/gravitational/teleport/api/client"

	"github.com/yeaboi/k8s-stack/internal/teleportaccess/config"
)

// Client is a connected Teleport API client whose identity file reloads when tbot renews it.
type Client struct {
	*client.Client
	creds    *client.DynamicIdentityFileCreds
	username string
	cluster  string
	version  string
}

// Connect dials Teleport using the identity file written by tbot (or, in development, the local tsh
// profile when no identity file is configured).
func Connect(ctx context.Context, cfg config.TeleportConfig, log *slog.Logger) (*Client, error) {
	c := &Client{}
	var creds []client.Credentials
	switch {
	case cfg.IdentityFile != "":
		dyn, err := client.NewDynamicIdentityFileCreds(cfg.IdentityFile)
		if err != nil {
			return nil, fmt.Errorf("load identity %s: %w", cfg.IdentityFile, err)
		}
		c.creds = dyn
		creds = []client.Credentials{dyn}
	default:
		creds = []client.Credentials{client.LoadProfile("", "")}
	}
	ccfg := client.Config{
		Credentials:              creds,
		DialInBackground:         false,
		DialTimeout:              15 * time.Second,
		InsecureAddressDiscovery: cfg.Insecure,
	}
	if cfg.Addr != "" {
		ccfg.Addrs = []string{cfg.Addr}
	}
	clt, err := client.New(ctx, ccfg)
	if err != nil {
		return nil, fmt.Errorf("connect to teleport %q: %w", cfg.Addr, err)
	}
	c.Client = clt
	ping, err := clt.Ping(ctx)
	if err != nil {
		return nil, fmt.Errorf("ping teleport: %w", err)
	}
	c.cluster, c.version = ping.ClusterName, ping.ServerVersion
	if me, err := clt.GetCurrentUser(ctx); err == nil {
		c.username = me.GetName()
	}
	log.Info("connected to teleport", "cluster", c.cluster, "version", c.version, "identity", c.username, "addr", cfg.Addr)
	if c.creds != nil {
		go c.watchIdentity(ctx, cfg.IdentityFile, log)
	}
	return c, nil
}

// Username is the identity's Teleport username (e.g. bot-teleport-mcp).
func (c *Client) Username() string { return c.username }

// ClusterName of the connected cluster.
func (c *Client) ClusterName() string { return c.cluster }

// ServerVersion of the connected cluster.
func (c *Client) ServerVersion() string { return c.version }

func (c *Client) watchIdentity(ctx context.Context, path string, log *slog.Logger) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		log.Warn("identity watcher unavailable; falling back to periodic reload", "err", err)
		c.reloadLoop(ctx, log)
		return
	}
	defer func() { _ = w.Close() }()
	_ = w.Add(filepath.Dir(path))
	debounce := time.NewTimer(time.Hour)
	debounce.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-w.Events:
			if filepath.Clean(ev.Name) == filepath.Clean(path) || ev.Has(fsnotify.Create) || ev.Has(fsnotify.Write) || ev.Has(fsnotify.Remove) {
				debounce.Reset(2 * time.Second)
			}
		case <-debounce.C:
			if _, err := os.Stat(path); err != nil {
				continue
			}
			if err := c.creds.Reload(); err != nil {
				log.Warn("identity reload failed", "err", err)
			} else {
				log.Info("identity reloaded")
			}
		case err := <-w.Errors:
			log.Warn("identity watcher error", "err", err)
		}
	}
}

func (c *Client) reloadLoop(ctx context.Context, log *slog.Logger) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := c.creds.Reload(); err != nil {
				log.Warn("identity reload failed", "err", err)
			}
		}
	}
}
