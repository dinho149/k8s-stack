# ADR 0003 — `teleport.127.0.0.1.nip.io:3080` locally, resolved in-cluster by a CoreDNS rewrite

**Decision.** The local cluster name and public address use nip.io on port 3080 (host ports 80/443 belong to another kind
cluster on the development machine). Inside the cluster a CoreDNS `rewrite` maps the public host (and `*.` app subdomains)
to the proxy NodePort Service on 3080, so agents, tbot and the access services use the **public address** exactly as in the cloud.

**Why.** The Teleport proxy redirects unknown Host headers to the app launcher and advertises reverse tunnels on the public
address, so in-cluster clients cannot simply use the Service DNS name. `*.localhost` does not resolve on macOS; `.local`
triggers mDNS.

**Consequences.** Offline machines need an `/etc/hosts` entry; the CoreDNS patch is kind-only (`LocalDns` component).
