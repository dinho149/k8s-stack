FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -o /dogfood ./cmd/dogfood
FROM debian:bookworm-slim
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 bash && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://dl.k8s.io/release/v1.34.0/bin/linux/${TARGETARCH}/kubectl" -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl \
 && curl -fsSL "https://get.helm.sh/helm-v3.18.6-linux-${TARGETARCH}.tar.gz" | tar -xz -C /tmp && mv /tmp/linux-${TARGETARCH}/helm /usr/local/bin/helm
WORKDIR /workspace
COPY --from=build /dogfood /usr/local/bin/dogfood
COPY scripts ./scripts
COPY deploy ./deploy
RUN mkdir -p .dogfood && chown -R 10001:10001 /workspace
RUN useradd --create-home --uid 10001 dogfood
USER dogfood
ENTRYPOINT ["dogfood"]
