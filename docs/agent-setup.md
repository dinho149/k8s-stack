# Claude Agent SDK and chat installation

For local development, run `make setup` and `make up`, configure the agent in `.env` as described in the [README](../README.md#optional-agent), then run `make agent`. The TypeScript implementation lives in `services/agent`. Use organization cloud credentials and approved model IDs; do not use personal Claude subscription credentials for this shared service.

## Providers

Bedrock:

```sh
export AGENT_PROVIDER=bedrock
export AWS_REGION=eu-west-2
export BEDROCK_MODEL='<enabled model or inference-profile ID>'
```

Vertex:

```sh
export AGENT_PROVIDER=vertex
export ANTHROPIC_VERTEX_PROJECT_ID='<project>'
export CLOUD_ML_REGION=europe-west1
export VERTEX_MODEL='<enabled Claude model ID>'
```

Both sets can be present. Backstage's provider selector starts a fresh conversation when changed; chat uses the deployment's default provider. Deploy separate chat worker endpoints for separate cloud routing policies. Set `DOGFOOD_API_URL`, `DOGFOOD_SERVICE_TOKEN`, and `AGENT_STATE_DIR`. `AGENT_CONCURRENCY` defaults to 4; `AGENT_MAX_BUDGET_USD` defaults to 0.5 per turn, with a 120-second timeout and 12-turn limit. Cloud-side account budgets and quotas remain authoritative.

The infrastructure adapters provision an AWS agent role or Google service account. Annotate Kubernetes service account `platform/dogfood-agent` using the corresponding output. Cross-cloud access requires explicitly configured workload federation; the module for one cloud does not automatically grant access to the other.

## Slack

Create an internal Slack app with bot scopes `chat:write`, `im:history`, and `app_mentions:read`. Enable events `message.im` and `app_mention` at `https://<agent-host>/chat/slack`. Install it in the workspace. Set `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, and comma-separated `SLACK_ALLOWED_TEAMS` (workspace IDs). Signed requests older than five minutes are rejected.

## Teams

Register an Entra application and Azure Bot with the Teams channel. Configure messaging endpoint `https://<agent-host>/chat/teams`; install the Teams app for the intended users. Set `TEAMS_APP_ID`, `TEAMS_APP_SECRET`, `TEAMS_APP_TENANT_ID`, and comma-separated `TEAMS_ALLOWED_TENANTS`. Incoming Bot Framework JWTs are checked against issuer/audience and the tenant allowlist. Stored service URLs are restricted to Bot Framework delivery domains. Only personal conversations execute actions.

## Google Chat

Configure a Chat app with HTTP endpoint `https://<agent-host>/chat/google` and an authentication audience matching `GOOGLE_CHAT_AUDIENCE`. Set `GOOGLE_CHAT_ALLOWED_DOMAINS` to the Workspace domain IDs carried by interaction events. Use a Google service account with Chat API access and ADC for replies. This implementation accepts Google-issued ID tokens whose service identity is `chat@system.gserviceaccount.com`; configure the endpoint URL audience accordingly. Enable direct messages and install the app for the intended users. Workspace add-on event envelopes are not supported.

## Linking and examples

Sign into Backstage, choose **Connect chat account**, then send `/link <code>` to the bot in a personal conversation within five minutes. The code is single-use. This is also the notification subscription for that channel.

Try:

- “What policies apply to my environments?”
- “Why did pr-42 fail?”
- “Add five minutes to pr-42.”
- “Set pr-42 to expire in five minutes.”
- “Promote image … at revision … to staging.”

Destruction uses a portal confirmation; the model cannot confirm its own destructive request. Promotions dispatch a GitHub workflow and are reported as requests, never as completed releases. Configure protected GitHub environments before enabling promotions.

Before exposing the service, configure HTTPS routing, request rate limits, external secret delivery, and private access between the agent, Backstage, and lifecycle API. Channel apps, organization admin installation, cloud model access, and real tenant tests require installation-specific credentials.
