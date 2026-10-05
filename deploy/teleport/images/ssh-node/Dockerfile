# Dummy SSH server: the Teleport binary (from the official distroless image) on a minimal Wolfi base
# that has a login shell and a `dev` user, so `tsh ssh dev@ssh-dev-0` gets a real shell.
#
# Bases are pinned by digest (Dependabot refreshes them). Refresh manually:
#   docker buildx imagetools inspect public.ecr.aws/gravitational/teleport-distroless-debug:18.11.1
#   docker buildx imagetools inspect cgr.dev/chainguard/wolfi-base:latest
FROM public.ecr.aws/gravitational/teleport-distroless-debug:18.11.1@sha256:af8910b2c9f45f05bf908272daa0fdfe2238304506b33ea7945a739f39dca1f9 AS teleport

# checkov:skip=CKV_DOCKER_2: a dummy Teleport SSH node; the pod has Kubernetes probes and kubelet ignores Docker HEALTHCHECK.
FROM cgr.dev/chainguard/wolfi-base:latest@sha256:9c2092b053779e14c82fb50f77b37bcc38b7d2c83972352d5813280f9d035b03
# bash: the login shell for `dev`. shadow: useradd. Nothing else (no curl, no procps, no sudo).
RUN apk add --no-cache bash shadow \
 && groupadd --gid 1000 dev \
 && useradd --create-home --shell /bin/bash --uid 1000 --gid 1000 dev \
 && mkdir -p /var/lib/teleport /etc/teleport \
 && chown -R 1000:1000 /var/lib/teleport /etc/teleport
COPY --from=teleport /usr/local/bin/teleport /usr/local/bin/teleport
# The SSH service runs as the `dev` user itself (uid/gid 1000, matching the Pod's runAsUser). A non-root
# Teleport node can only open sessions as its own user, which is exactly the one login this demo needs
# (`tsh ssh dev@ssh-dev-0`); no setuid, no capabilities, no root anywhere in the image.
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/teleport"]
CMD ["start", "-c", "/etc/teleport/teleport.yaml"]
