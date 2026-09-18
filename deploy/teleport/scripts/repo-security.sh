#!/usr/bin/env bash
# repo-security.sh <owner/name> — apply the GitHub repository security settings this repo's CI assumes.
#
# Everything here is idempotent and printed before it runs. Requires `gh auth login` with a token that
# has `repo` + `admin:repo_hook` scope (or a fine-grained token with Administration: write).
source "$(dirname "$0")/_common.sh"
repo="${1:-${REPO:-}}"
[[ -n "$repo" && "$repo" == */* ]] || ui::die "usage: make repo-security REPO=owner/name"
ui::require gh
default_branch="${DEFAULT_BRANCH:-main}"
# Every check listed here must exist as a job/workflow name in .github/workflows, otherwise merges block forever.
checks=(
  "ci / lint-and-unit"
  "ci / pre-commit"
  "codeql"
  "semgrep"
  "image-scan"
  "claude-security-review"
)

ui::section "GitHub security settings for $repo (branch $default_branch)"

step() { ui::step "$1"; shift; "$@" >/dev/null && ui::ok "done" || { ui::fail "failed: $*"; exit 1; }; }

step "secret scanning + push protection + Dependabot security updates" \
  gh api -X PATCH "repos/$repo" --input - <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" },
    "dependabot_security_updates": { "status": "enabled" }
  },
  "allow_auto_merge": false,
  "delete_branch_on_merge": true,
  "web_commit_signoff_required": true
}
JSON

step "Dependabot vulnerability alerts" gh api -X PUT "repos/$repo/vulnerability-alerts"

step "Actions: read-only default GITHUB_TOKEN, no PR approvals by Actions" \
  gh api -X PUT "repos/$repo/actions/permissions/workflow" --input - <<'JSON'
{ "default_workflow_permissions": "read", "can_approve_pull_request_reviews": false }
JSON

checks_json="$(printf '%s\n' "${checks[@]}" | python3 -c 'import json,sys; print(json.dumps([{"context": l.strip()} for l in sys.stdin if l.strip()]))')"
step "branch protection on $default_branch (required checks, code-owner review, signed commits, no force-push)" \
  gh api -X PUT "repos/$repo/branches/$default_branch/protection" --input - <<JSON
{
  "required_status_checks": { "strict": true, "checks": $checks_json },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "lock_branch": false
}
JSON

step "required signed commits on $default_branch" gh api -X POST "repos/$repo/branches/$default_branch/protection/required_signatures"

ui::box "Manual follow-ups" \
  "Secrets (Settings → Secrets → Actions): ANTHROPIC_API_KEY (Claude reviews); GITHUB_TOKEN is automatic" \
  "Environments: create 'release' with required reviewers if you want gated image releases" \
  "CODEOWNERS: replace @CHANGE-ME-security-owner in .github/CODEOWNERS with a real team" \
  "Code scanning: Settings → Code security → enable 'Code scanning' (SARIF uploads need it)" \
  "Private repos: Advanced Security must be enabled for secret scanning + code scanning"
