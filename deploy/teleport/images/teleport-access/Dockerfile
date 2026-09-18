# teleport-access: MCP server + access broker (one binary, subcommands)
#
# Build context is the REPOSITORY ROOT (the code lives in the root Go module):
#   docker build -f deploy/teleport/images/teleport-access/Dockerfile -t dogfood/teleport-access .
#
# Build stage: the official Go 1.26 image (Chainguard's free `go:latest` tracks Go 1.27, whose unicode
# tables no longer match the pinned golang.org/x/text and the binary panics at start-up; a version-matched
# Chainguard tag needs a paid registry). Runtime: Chainguard static (no shell, no package manager, nonroot).
# Both bases are pinned by digest; Dependabot (docker ecosystem) refreshes them weekly and CI re-scans.
# Refresh manually: docker buildx imagetools inspect docker.io/library/golang:1.26.6-alpine (must match the go.mod toolchain)
FROM docker.io/library/golang:1.26.7-alpine@sha256:28d89ee9cc0ff9fec75c82ca201e6bf7fdf9a679d4b7b24dfa04f2bb766bb468 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/teleport-access ./cmd/teleport-access

# checkov:skip=CKV_DOCKER_2: Kubernetes readiness/liveness probes cover health (see AccessServices.ts); the runtime image is
# distroless static with no shell or client to run a Docker HEALTHCHECK, which kubelet ignores anyway.
FROM cgr.dev/chainguard/static:latest@sha256:bf639cba19ba56329e6907ac26a7afcdde57a80b6aa66d5100da6883196e6b82
COPY --from=build /out/teleport-access /teleport-access
# nonroot (65532) is the only user in the static image; numeric so the kubelet can verify runAsNonRoot.
USER 65532:65532
ENTRYPOINT ["/teleport-access"]
CMD ["mcp"]
