# Dummy SSH server: the Teleport binary (from the official distroless image) on a slim Debian
# base that has a shell and a `dev` login user, so `tsh ssh dev@ssh-dev-0` gets a real shell.
ARG TELEPORT_VERSION=18.11.1
FROM public.ecr.aws/gravitational/teleport-distroless-debug:${TELEPORT_VERSION} AS teleport
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates procps curl && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /bin/bash dev \
 && echo 'dev ALL=(ALL) NOPASSWD: /usr/bin/id' > /etc/sudoers.d/dev-noop 2>/dev/null || true
COPY --from=teleport /usr/local/bin/teleport /usr/local/bin/teleport
RUN mkdir -p /var/lib/teleport /etc/teleport
ENTRYPOINT ["/usr/local/bin/teleport"]
CMD ["start", "-c", "/etc/teleport/teleport.yaml"]
