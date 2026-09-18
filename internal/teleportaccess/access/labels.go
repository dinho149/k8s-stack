// Package access reimplements the parts of Teleport's RBAC label matching that we need to explain
// "which role grants access to X" without importing Teleport's lib/ (which drags in the whole server).
package access

import (
	"fmt"
	"regexp"
	"strings"
)

// Wildcard matches any key or value.
const Wildcard = "*"

// MatchLabels reports whether target labels satisfy the role selector.
// Semantics mirror lib/services.MatchLabels: a "*": ["*"] selector matches everything; every selector
// key must exist in the target; a value list matches if any entry equals the target value, is "*",
// or is an anchored regex ("^...$") matching it.
func MatchLabels(selector map[string][]string, target map[string]string) (bool, error) {
	if len(selector) == 0 {
		return false, nil
	}
	if vals, ok := selector[Wildcard]; ok {
		for _, v := range vals {
			if v == Wildcard {
				return true, nil
			}
		}
	}
	for key, wanted := range selector {
		if key == Wildcard {
			continue
		}
		have, ok := target[key]
		if !ok {
			return false, nil
		}
		matched, err := matchValue(wanted, have)
		if err != nil {
			return false, err
		}
		if !matched {
			return false, nil
		}
	}
	return true, nil
}

func matchValue(wanted []string, have string) (bool, error) {
	for _, w := range wanted {
		if w == Wildcard || w == have {
			return true, nil
		}
		if strings.HasPrefix(w, "^") || strings.HasSuffix(w, "$") {
			re, err := regexp.Compile(w)
			if err != nil {
				return false, fmt.Errorf("bad label regex %q: %w", w, err)
			}
			if re.MatchString(have) {
				return true, nil
			}
		}
	}
	return false, nil
}

var traitRe = regexp.MustCompile(`\{\{\s*(internal|external)\.([A-Za-z0-9_.-]+)\s*\}\}`)

// ExpandTraits substitutes {{internal.x}} / {{external.x}} in every selector value with the user's
// traits. Values using functions (e.g. {{regexp.replace(...)}}) cannot be evaluated here; they are
// dropped and reported in the returned list so callers can flag uncertainty.
func ExpandTraits(selector map[string][]string, traits map[string][]string) (out map[string][]string, unresolved []string) {
	out = make(map[string][]string, len(selector))
	for k, vals := range selector {
		for _, v := range vals {
			if !strings.Contains(v, "{{") {
				out[k] = append(out[k], v)
				continue
			}
			m := traitRe.FindStringSubmatch(v)
			if m == nil || strings.TrimSpace(traitRe.ReplaceAllString(v, "")) != "" {
				unresolved = append(unresolved, v)
				continue
			}
			out[k] = append(out[k], traits[m[2]]...)
		}
		if len(out[k]) == 0 {
			// keep the key so "must exist" semantics still apply, with no possible value
			out[k] = []string{}
		}
	}
	return out, unresolved
}
