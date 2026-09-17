# k8s-teleport — single entry point for the local developer experience.
#
#   make            -> grouped help
#   make doctor     -> check toolchain
#   make up         -> kind + images + pulumi + wait, ends with a summary box
#   make status     -> one-screen dashboard
#
# Every recipe delegates to deploy/scripts/*.sh, which source deploy/scripts/lib/ui.sh
# for colours, spinners and tables (auto-plain under CI / NO_COLOR).
#
# Target help lines follow the pattern:   target: ## [Group] description
# GNU make 3.81 compatible (macOS default): tabs, no .ONESHELL, no RECIPEPREFIX.

SHELL := /bin/bash
.DEFAULT_GOAL := help

-include .env
export

# ---------------------------------------------------------------------------- variables
REPO_ROOT       := $(CURDIR)
STACK           ?= local
KIND_CLUSTER    ?= teleport-local
KUBE_CONTEXT    ?= kind-$(KIND_CLUSTER)
TELEPORT_VERSION ?= 18.11.1
PROXY_ADDR      ?= teleport.127.0.0.1.nip.io:3080
IMAGE_TAG       ?= dev
PULUMI_BACKEND_URL      ?= file://$(REPO_ROOT)/infra/.state
PULUMI_CONFIG_PASSPHRASE ?= local-dev
SCRIPTS         := $(REPO_ROOT)/deploy/scripts
INFRA           := $(REPO_ROOT)/infra/teleport
ifneq ($(or $(CI),$(NO_COLOR)),)
PULUMI_COLOR    := never
else
PULUMI_COLOR    ?= always
endif
PULUMI          := cd $(INFRA) && pulumi --non-interactive --color $(PULUMI_COLOR)
TSH             := $(REPO_ROOT)/bin/tsh --insecure --proxy $(PROXY_ADDR)
KUBECTL         := kubectl --context $(KUBE_CONTEXT)
UI              := source $(SCRIPTS)/lib/ui.sh &&

ifeq ($(KIND_CLUSTER),kind)
$(error refusing to run against the default kind cluster "kind"; set KIND_CLUSTER to something else)
endif

# ---------------------------------------------------------------------------- help
.PHONY: help
help: ## [Start here] Show this help
	@$(UI) printf '\n%s%sk8s-teleport%s  %sstack=%s  cluster=%s  proxy=https://%s%s\n' "$$UI_BOLD" "$$UI_CYAN" "$$UI_RESET" "$$UI_DIM" "$(STACK)" "$(KIND_CLUSTER)" "$(PROXY_ADDR)" "$$UI_RESET"
	@$(UI) awk -v bold="$$UI_BOLD" -v cyan="$$UI_CYAN" -v dim="$$UI_DIM" -v reset="$$UI_RESET" ' \
	  /^[a-zA-Z0-9_%-]+:.*## \[/ { \
	    split($$0, a, "## \\["); split(a[2], b, "\\] "); target=$$1; sub(/:.*/, "", target); \
	    group=b[1]; desc=b[2]; \
	    if (!(group in seen)) { order[++n]=group; seen[group]=1 } \
	    items[group]=items[group] sprintf("  %s%-22s%s %s\n", cyan, target, reset, desc) \
	  } \
	  END { for (i=1;i<=n;i++) { printf "\n%s%s%s\n%s", bold, order[i], reset, items[order[i]] } print "" }' $(MAKEFILE_LIST)
	@$(UI) printf '%sVariables:%s STACK=%s  KIND_CLUSTER=%s  IMAGE_TAG=%s  (override on the command line or in .env)\n\n' "$$UI_DIM" "$$UI_RESET" "$(STACK)" "$(KIND_CLUSTER)" "$(IMAGE_TAG)"

.PHONY: doctor
doctor: ## [Start here] Check toolchain, ports, kube context, Pulumi backend
	@$(SCRIPTS)/doctor.sh

.PHONY: tsh
tsh: ## [Start here] Download tsh/tctl/tbot $(TELEPORT_VERSION) into ./bin
	@$(SCRIPTS)/install-tsh.sh

.PHONY: deps
deps: ## [Start here] Install npm + go dependencies
	@$(UI) ui::spinner "npm install (workspaces)" npm install --no-fund --no-audit
	@$(UI) ui::spinner "go mod download" bash -c 'cd services/teleport-access 2>/dev/null && go mod download || true'

# ---------------------------------------------------------------------------- lifecycle
.PHONY: kind-up
kind-up: ## [Lifecycle] Create the kind cluster (idempotent)
	@$(SCRIPTS)/kind-up.sh

.PHONY: images
images: ## [Lifecycle] Build service images and load them into kind (or push for cloud)
	@$(SCRIPTS)/load-images.sh $(IMAGE_TAG)

.PHONY: stack-init
stack-init: ## [Lifecycle] Select/create the Pulumi stack on the local file backend
	@$(UI) ui::step "Pulumi backend $(PULUMI_BACKEND_URL)"
	@mkdir -p $(INFRA)/../.state
	@$(PULUMI) login $(PULUMI_BACKEND_URL) >/dev/null
	@($(PULUMI) stack select $(STACK) 2>/dev/null) || ($(PULUMI) stack init $(STACK) --secrets-provider passphrase)
	@$(UI) ui::ok "stack $(STACK) selected"

.PHONY: preview
preview: stack-init ## [Lifecycle] pulumi preview for STACK (cloud stacks render against kind: make preview STACK=dev-eks)
	@$(UI) ui::section "pulumi preview ($(STACK))"
	@$(PULUMI) preview --stack $(STACK) --diff $(PULUMI_ARGS)

.PHONY: deploy
deploy: stack-init ## [Lifecycle] pulumi up only (no kind/images)
	@$(UI) ui::section "pulumi up ($(STACK))"
	@$(PULUMI) up --stack $(STACK) --yes --skip-preview $(PULUMI_ARGS)

.PHONY: wait
wait: ## [Lifecycle] Wait until Teleport proxy/auth/operator are ready
	@$(UI) ui::section "Waiting for Teleport"
	@$(SCRIPTS)/wait-teleport.sh

.PHONY: up
up: ## [Lifecycle] Full bring-up: doctor → kind → images → pulumi up → wait → summary
	@$(UI) ui::section "1/5 Toolchain"
	@$(SCRIPTS)/doctor.sh >/dev/null 2>&1 && $(UI) ui::ok "doctor passed" || { $(SCRIPTS)/doctor.sh; exit 1; }
	@$(UI) ui::section "2/5 kind cluster"
	@$(SCRIPTS)/kind-up.sh
	@$(UI) ui::section "3/5 Service images"
	@$(SCRIPTS)/load-images.sh $(IMAGE_TAG)
	@$(UI) ui::section "4/5 Pulumi ($(STACK))"
	@$(MAKE) --no-print-directory stack-init
	@$(PULUMI) up --stack $(STACK) --yes --skip-preview $(PULUMI_ARGS)
	@$(UI) ui::section "5/5 Waiting for Teleport"
	@$(SCRIPTS)/wait-teleport.sh
	@$(MAKE) --no-print-directory summary

.PHONY: summary
summary: ## [Lifecycle] Print the post-deploy summary box
	@$(UI) ui::box "Teleport is up" \
	  "Web UI      https://$(PROXY_ADDR)   (self-signed cert)" \
	  "Login       make login          (GitHub SSO)" \
	  "            make login-local    (local admin; first run: make bootstrap-admin)" \
	  "Dashboard   make status  /  make urls  /  make requests" \
	  "Agent REPL  make agent-cli" \
	  "Tear down   make down"

.PHONY: down
down: ## [Lifecycle] pulumi destroy + delete the kind cluster
	@$(UI) ui::section "Tearing down $(STACK)"
	@-$(PULUMI) login $(PULUMI_BACKEND_URL) >/dev/null 2>&1 && $(PULUMI) destroy --stack $(STACK) --yes --skip-preview
	@-$(UI) ui::spinner "Deleting kind cluster $(KIND_CLUSTER)" kind delete cluster --name $(KIND_CLUSTER)

.PHONY: nuke
nuke: down ## [Lifecycle] down + remove local state, seeded credentials and ./bin
	@rm -rf $(INFRA)/../.state tests/.state bin .logs
	@$(UI) ui::ok "local state removed"

# ---------------------------------------------------------------------------- access
.PHONY: bootstrap-admin
bootstrap-admin: ## [Access] Print a reset link to set the local admin password + OTP
	@$(SCRIPTS)/bootstrap-admin.sh admin

.PHONY: login
login: ## [Access] tsh login via GitHub SSO (opens the browser)
	@$(TSH) login --auth github && $(TSH) status

.PHONY: login-local
login-local: ## [Access] tsh login as a local user (USER=admin)
	@$(TSH) login --auth local --user $(or $(USER_NAME),admin) && $(TSH) status

.PHONY: github-sso
github-sso: stack-init ## [Access] Store GitHub OAuth App credentials for STACK (prompts)
	@$(SCRIPTS)/github-sso.sh

.PHONY: requests
requests: ## [Access] List access requests
	@$(SCRIPTS)/requests.sh

.PHONY: approve
approve: ## [Access] Approve a request: make approve ID=<id> [REASON=...]
	@test -n "$(ID)" || { echo "usage: make approve ID=<request-id> [REASON=...]"; exit 1; }
	@$(SCRIPTS)/tctl.sh request approve --reason="$(or $(REASON),approved via make)" $(ID) && $(UI) ui::ok "approved $(ID)"

.PHONY: deny
deny: ## [Access] Deny a request: make deny ID=<id> REASON=...
	@test -n "$(ID)" || { echo "usage: make deny ID=<request-id> REASON=..."; exit 1; }
	@$(SCRIPTS)/tctl.sh request deny --reason="$(or $(REASON),denied via make)" $(ID) && $(UI) ui::ok "denied $(ID)"

.PHONY: agent-cli
agent-cli: ## [Access] Chat with the access agent in your terminal (AS=alice; AUTH=api-key|subscription, default: your Claude login)
	@$(SCRIPTS)/agent-cli.sh $(or $(AS),admin) $(AGENT_ARGS)

.PHONY: claude-token
claude-token: stack-init ## [Access] Store a Claude Pro/Max subscription token for the in-cluster agent (runs claude setup-token)
	@$(SCRIPTS)/claude-token.sh

# ---------------------------------------------------------------------------- observe
.PHONY: status
status: ## [Observe] Dashboard: cluster, pods, Teleport inventory, pending requests, your session
	@$(SCRIPTS)/status.sh

.PHONY: watch
watch: ## [Observe] Dashboard refreshed every 5s
	@while true; do clear; $(SCRIPTS)/status.sh; sleep 5; done

.PHONY: urls
urls: ## [Observe] Every URL you can open
	@$(SCRIPTS)/urls.sh

.PHONY: logs
logs: ## [Observe] Follow logs: make logs SVC=auth|proxy|operator|kube-agent|ssh|postgres|broker|mcp|agent
	@$(SCRIPTS)/logs.sh $(or $(SVC),auth)

.PHONY: events
events: ## [Observe] Recent warning events across Teleport namespaces
	@for ns in teleport teleport-agent teleport-dummies teleport-access; do $(KUBECTL) -n $$ns get events --field-selector type=Warning --sort-by=.lastTimestamp 2>/dev/null | tail -n 15; done

.PHONY: port-forward
port-forward: ## [Observe] Port-forward a service: make port-forward SVC=mcp|broker|agent
	@$(SCRIPTS)/port-forward.sh $(or $(SVC),mcp)

.PHONY: tctl
tctl: ## [Observe] Run tctl in the auth pod: make tctl ARGS="get roles"
	@$(SCRIPTS)/tctl.sh $(ARGS)

# ---------------------------------------------------------------------------- test
.PHONY: test-unit
test-unit: ## [Test] Pulumi + service unit tests (TS vitest, Go)
	@$(UI) ui::section "Unit tests"
	@npm test --workspaces --if-present
	@cd services/teleport-access 2>/dev/null && go test ./... || true

.PHONY: seed-test-users
seed-test-users: harness-identity ## [Test] Headless password+TOTP enrolment for alice/bob
	@$(SCRIPTS)/seed-test-users.sh

.PHONY: harness-identity
harness-identity: ## [Test] Extract the ci-harness bot identity into tests/.state
	@$(SCRIPTS)/harness-identity.sh

.PHONY: test-integration
test-integration: harness-identity ## [Test] Go integration tests against the live cluster
	@$(UI) ui::section "Integration tests"
	@cd tests/integration && TELEPORT_PROXY=$(PROXY_ADDR) HARNESS_IDENTITY=$(REPO_ROOT)/tests/.state/harness.identity TELEPORT_INSECURE=1 go test ./... -tags=integration -count=1 -timeout 15m -v

.PHONY: test-e2e
test-e2e: ## [Test] tsh end-to-end scenarios
	@$(UI) ui::section "End-to-end (tsh)"
	@for t in tests/e2e/[0-9]*.sh; do bash $$t || exit 1; done

.PHONY: test
test: test-unit test-integration test-e2e ## [Test] Everything

.PHONY: lint
lint: ## [Test] typecheck + eslint + go vet + gitleaks + kubeconform (rendered CRs)
	@$(UI) ui::section "Lint"
	@npm run typecheck --workspaces --if-present
	@npm run lint --workspaces --if-present
	@cd services/teleport-access 2>/dev/null && go vet ./... || true
	@command -v gitleaks >/dev/null && gitleaks detect --no-banner --redact || $(UI) ui::warn "gitleaks not installed, skipped"
	@$(MAKE) --no-print-directory render

.PHONY: render
render: ## [Test] Render Teleport CRs offline (mocks) and validate them with kubeconform
	@$(SCRIPTS)/render-crs.sh
