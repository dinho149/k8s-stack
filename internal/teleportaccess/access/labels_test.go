package access

import "testing"

func TestMatchLabels(t *testing.T) {
	cases := []struct {
		name string
		sel  map[string][]string
		tgt  map[string]string
		want bool
	}{
		{"exact", map[string][]string{"env": {"dev"}}, map[string]string{"env": "dev", "x": "y"}, true},
		{"list", map[string][]string{"env": {"local", "dev"}}, map[string]string{"env": "dev"}, true},
		{"miss", map[string][]string{"env": {"prod"}}, map[string]string{"env": "dev"}, false},
		{"missing key", map[string][]string{"env": {"*"}}, map[string]string{"tier": "data"}, false},
		{"wildcard value", map[string][]string{"env": {"*"}}, map[string]string{"env": "anything"}, true},
		{"wildcard all", map[string][]string{"*": {"*"}}, map[string]string{}, true},
		{"regex", map[string][]string{"env": {"^(dev|local)$"}}, map[string]string{"env": "local"}, true},
		{"two keys one fails", map[string][]string{"env": {"dev"}, "tier": {"web"}}, map[string]string{"env": "dev", "tier": "data"}, false},
		{"empty selector", map[string][]string{}, map[string]string{"env": "dev"}, false},
	}
	for _, c := range cases {
		got, err := MatchLabels(c.sel, c.tgt)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestExpandTraits(t *testing.T) {
	sel := map[string][]string{"team": {"{{external.team}}", "platform"}, "owner": {"{{email.local(external.email)}}"}}
	out, unresolved := ExpandTraits(sel, map[string][]string{"team": {"app", "data"}})
	if len(out["team"]) != 3 || out["team"][0] != "app" || out["team"][2] != "platform" {
		t.Fatalf("team expansion wrong: %v", out["team"])
	}
	if len(unresolved) != 1 || len(out["owner"]) != 0 {
		t.Fatalf("function template should be unresolved: %v %v", unresolved, out["owner"])
	}
}
