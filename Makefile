SHELL := /bin/bash
.PHONY: build lint test-fast test-scoped test ship-gate doctor local agent portal
build:
	go build -o bin/stack ./cmd/stack
	npm run build
lint:
	@test -z "$$(gofmt -l cmd internal)" || (gofmt -l cmd internal; exit 1)
	go vet ./cmd/... ./internal/...
	npm run typecheck
	for script in scripts/*.sh; do bash -n "$$script"; done
	tofu fmt -check -recursive infra
test-fast:
	go test -race ./cmd/... ./internal/...
	npm test
test-scoped: test-fast
test: lint test-fast
	helm lint deploy/charts/sample deploy/charts/platform
ship-gate: test build
doctor:
	go run ./cmd/stack doctor
local:
	go run ./cmd/stack up --bootstrap
agent:
	npm run agent
portal:
	npm run portal
