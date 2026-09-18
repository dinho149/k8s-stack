SHELL := /bin/bash
.DEFAULT_GOAL := help

# Public interface: make <target> [KEY=value]. Helpers are implementation details.
# Export only documented inputs; never interpolate user values into shell code.
export NAME IMAGE REVISION MINUTES CONFIRMATION CONFIRM SERVICE
export REPOSITORY TOOLS RUNS CONCURRENCY VERBOSE WITH_DEPS

TARGETS := help help-all setup doctor up open status logs stop restart down reset clean \
 local portal agent agent-stop sample-build preview-up preview-status preview-down \
 preview-retry preview-extend preview-diagnostics build typecheck format format-check \
 lint test-fast test-scoped test ship-gate test-portal test-agent test-local \
 browser-install audit infra-validate catalog-check catalog-sync tool-routes \
 benchmark benchmark-report test-isolation desktop desktop-open desktop-build desktop-package test-desktop test-desktop-ui

.PHONY: $(TARGETS)
$(TARGETS):
	@command -v python3 >/dev/null 2>&1 || { printf 'Python 3.9+ is required. See README.md prerequisites.\n'; exit 1; }
	@python3 scripts/local.py $@
