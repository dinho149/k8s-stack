SHELL := /bin/bash
.DEFAULT_GOAL := help

# Public interface: make <target> [KEY=value]. Helpers are implementation details.
# Export only documented inputs; never interpolate user values into shell code.
export NAME IMAGE REVISION MINUTES CONFIRMATION CONFIRM SERVICE
export REPOSITORY TOOLS RUNS CONCURRENCY VERBOSE WITH_DEPS
# Teleport targets (make teleport-*): documented inputs only, forwarded to deploy/teleport/scripts.
export STACK USER_NAME ID REASON ARGS SVC AS AGENT_ARGS USERS LOCAL_TLS WEB_LOGIN IMAGE_TAG PULUMI_ARGS TELEPORT CI_PREVIEW TSH_RELOGIN

TARGETS := help help-all setup doctor up open status logs stop restart down reset clean \
 local portal agent agent-stop sample-build preview-up preview-status preview-down \
 preview-retry preview-extend preview-diagnostics build typecheck format format-check \
 lint test-fast test-scoped test ship-gate test-portal test-agent test-local \
 browser-install audit infra-validate catalog-check catalog-sync tool-routes \
 benchmark benchmark-report test-isolation \
 teleport-up teleport-deploy teleport-preview teleport-down teleport-status teleport-doctor teleport-urls \
 teleport-login teleport-web-login teleport-tctl teleport-requests teleport-approve teleport-deny teleport-agent-cli \
 teleport-logs teleport-port-forward teleport-tls teleport-github-sso teleport-claude-token teleport-tsh teleport-images \
 teleport-bootstrap-users teleport-bootstrap-admin teleport-seed-test-users teleport-render teleport-test \
 teleport-test-integration teleport-test-e2e teleport-hooks teleport-secrets-guard teleport-wait

.PHONY: $(TARGETS)
$(TARGETS):
	@command -v python3 >/dev/null 2>&1 || { printf 'Python 3.9+ is required. See README.md prerequisites.\n'; exit 1; }
	@python3 scripts/local.py $@
