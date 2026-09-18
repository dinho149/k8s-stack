// totp prints the current TOTP code for a base32 secret (used by tests/teleport/e2e to log in headlessly).
//
//	go run ./totp -secret JBSWY3DPEHPK3PXP
//	go run ./totp -users .dogfood/teleport/state/users.json -user alice
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/pquerna/otp/totp"
)

func main() {
	secret := flag.String("secret", "", "base32 TOTP secret")
	usersFile := flag.String("users", "", "users.json written by seed-users")
	user := flag.String("user", "", "user name inside users.json")
	flag.Parse()
	if *secret == "" && *usersFile != "" {
		b, err := os.ReadFile(*usersFile)
		if err != nil {
			fail(err)
		}
		var users map[string]struct {
			Password   string `json:"password"`
			TOTPSecret string `json:"totp_secret"`
		}
		if err := json.Unmarshal(b, &users); err != nil {
			fail(err)
		}
		u, ok := users[*user]
		if !ok {
			fail(fmt.Errorf("user %q not in %s", *user, *usersFile))
		}
		*secret = u.TOTPSecret
	}
	if *secret == "" {
		fail(fmt.Errorf("-secret or -users/-user required"))
	}
	code, err := totp.GenerateCode(*secret, time.Now())
	if err != nil {
		fail(err)
	}
	fmt.Println(code)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
