// seed-users enrols local Teleport users headlessly (password + TOTP) using a bot identity that may
// create reset tokens. It writes tests/.state/users.json for the e2e scripts.
//
//	TELEPORT_PROXY=teleport.127.0.0.1.nip.io:3080 HARNESS_IDENTITY=tests/.state/harness.identity TELEPORT_INSECURE=1 \
//	  go run ./seed-users -users alice,bob -out tests/.state/users.json
//
// A reset token deletes the user's existing MFA devices, so `make up` passes -skip-existing to leave
// already-enrolled users alone; -force re-enrols them (make bootstrap-admin).
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gravitational/teleport/api/client"
	"github.com/gravitational/teleport/api/client/proto"
	"github.com/gravitational/teleport/api/types"
	"github.com/gravitational/trace"
	"github.com/pquerna/otp/totp"
)

type cred struct {
	Password   string `json:"password"`
	TOTPSecret string `json:"totp_secret"`
	// Enrolment itself consumes a TOTP code; Teleport rejects a reused code, so the login helpers
	// (deploy/scripts/lib/tsh-login.sh) wait for a window later than this timestamp.
	EnrolledAt int64 `json:"enrolled_at"`
}

func main() {
	users := flag.String("users", "alice,bob", "comma separated local users to enrol")
	out := flag.String("out", "tests/.state/users.json", "credentials file to write")
	skipExisting := flag.Bool("skip-existing", false, "leave users that are already in the credentials file untouched")
	force := flag.Bool("force", false, "re-enrol users even when -skip-existing is set")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	clt, err := connect(ctx)
	if err != nil {
		fail(err)
	}
	defer func() { _ = clt.Close() }()

	existing := map[string]cred{}
	if b, err := os.ReadFile(*out); err == nil {
		_ = json.Unmarshal(b, &existing)
	}
	for _, u := range strings.Split(*users, ",") {
		u = strings.TrimSpace(u)
		if u == "" {
			continue
		}
		if _, ok := existing[u]; ok && *skipExisting && !*force {
			fmt.Printf("skipping %s (already enrolled)\n", u)
			continue
		}
		c, err := enrol(ctx, clt, u)
		if err != nil {
			fail(fmt.Errorf("enrol %s: %w", u, err))
		}
		existing[u] = c
		fmt.Printf("enrolled %s (password + TOTP)\n", u)
	}
	if err := os.MkdirAll(dir(*out), 0o700); err != nil {
		fail(err)
	}
	b, _ := json.MarshalIndent(existing, "", "  ") //nolint:gosec // this file IS the (0600, gitignored) credential store for test users
	if err := os.WriteFile(*out, b, 0o600); err != nil {
		fail(err)
	}
	fmt.Printf("wrote %s\n", *out)
}

func connect(ctx context.Context) (*client.Client, error) {
	addr := os.Getenv("TELEPORT_PROXY")
	id := os.Getenv("HARNESS_IDENTITY")
	if addr == "" || id == "" {
		return nil, fmt.Errorf("TELEPORT_PROXY and HARNESS_IDENTITY are required")
	}
	return client.New(ctx, client.Config{Addrs: []string{addr}, Credentials: []client.Credentials{client.LoadIdentityFile(id)}, InsecureAddressDiscovery: os.Getenv("TELEPORT_INSECURE") == "1", DialTimeout: 20 * time.Second})
}

// enrol resets the user's authentication and completes it with a fresh password and TOTP device.
func enrol(ctx context.Context, clt *client.Client, user string) (cred, error) {
	tok, err := resetToken(ctx, clt, user)
	if err != nil {
		return cred{}, fmt.Errorf("create reset token: %w", err)
	}
	pw := randomPassword()
	// Ask the auth server for a TOTP registration challenge bound to the token.
	chal, err := clt.CreateRegisterChallenge(ctx, &proto.CreateRegisterChallengeRequest{TokenID: tok.GetName(), DeviceType: proto.DeviceType_DEVICE_TYPE_TOTP})
	if err != nil {
		return cred{}, fmt.Errorf("register challenge: %w", err)
	}
	t := chal.GetTOTP()
	if t == nil {
		return cred{}, fmt.Errorf("no TOTP challenge returned")
	}
	code, err := totp.GenerateCode(t.GetSecret(), time.Now())
	if err != nil {
		return cred{}, err
	}
	_, err = clt.ChangeUserAuthentication(ctx, &proto.ChangeUserAuthenticationRequest{
		TokenID:                tok.GetName(),
		NewPassword:            []byte(pw),
		NewMFARegisterResponse: &proto.MFARegisterResponse{Response: &proto.MFARegisterResponse_TOTP{TOTP: &proto.TOTPRegisterResponse{Code: code}}},
		NewDeviceName:          "seed-totp",
	})
	if err != nil {
		return cred{}, fmt.Errorf("change authentication: %w", err)
	}
	return cred{Password: pw, TOTPSecret: t.GetSecret(), EnrolledAt: time.Now().Unix()}, nil
}

// resetToken retries while the user does not exist yet: the Teleport operator creates TeleportUser
// CRs asynchronously and `make up` calls this right after the proxy answers.
func resetToken(ctx context.Context, clt *client.Client, user string) (types.UserToken, error) {
	deadline := time.Now().Add(60 * time.Second)
	for {
		tok, err := clt.CreateResetPasswordToken(ctx, &proto.CreateResetPasswordTokenRequest{Name: user, TTL: proto.Duration(5 * time.Minute), Type: "password"})
		if err == nil {
			return tok, nil
		}
		if !trace.IsNotFound(err) || time.Now().After(deadline) {
			return nil, err
		}
		fmt.Printf("user %s not created yet, retrying...\n", user)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

func randomPassword() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return "Tp!" + base64.RawURLEncoding.EncodeToString(b)
}

func dir(p string) string {
	if i := strings.LastIndex(p, "/"); i > 0 {
		return p[:i]
	}
	return "."
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
