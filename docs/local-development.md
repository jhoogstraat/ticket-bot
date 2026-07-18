# Local development

## Requirements

- Bun 1.3 or newer (mise selects Bun 1.3).
- Git with an initial commit and a reachable `main` branch.
- Docker for local Restate.
- Codex authentication when using `HARNESS_MODE=codex`.

## Setup and tests

```bash
cp .env.example .env
bun install
bun run format
bun run check
```

Environment variables are documented in `.env.example`. Fake integrations and harness are the defaults. Every submitted repository URL must start with one of the comma-separated `TRUSTED_REPOSITORY_URL_PREFIXES`. `ADAPTER_MODE=real` requires `JIRA_BASE_URL`, `JIRA_TOKEN`, `WEBHOOK_SIGNING_SECRET`, and the token for each forge the deployment uses (`GITHUB_TOKEN` or `GITLAB_TOKEN`). `HARNESS_MODE=codex` independently selects the real Codex SDK adapter. Integration secrets are removed from the Codex runtime environment.

## Start Restate and the application

```bash
docker compose up -d restate
bun run dev
```

The Restate endpoint is served by `restate.serve`, while the public webhook API listens on `APP_PORT` (3000 by default). In production, expose only the webhook API. Keep Restate ingress on a private network; the API forwards each verified provider delivery with its stable ID as the Restate idempotency key.

For deployments outside a private local network, configure Restate request identity and set `RESTATE_IDENTITY_KEYS` to the matching comma-separated `publickeyv1_*` values. The SDK then rejects deployment requests that were not signed by that Restate instance.

Register the service endpoint:

```bash
curl -X POST http://localhost:9070/deployments \
  -H 'content-type: application/json' \
  -d '{"uri":"http://host.docker.internal:9080"}'
```

## Trigger the fake flow

Submit the bundled fake Jira ticket to the webhook API. Set `TRUSTED_REPOSITORY_URL_PREFIXES` to a prefix containing the test repository first. Fake mode accepts unsigned requests; real mode requires `x-bug-bot-signature: sha256=<HMAC-SHA256(raw-body)>`.

```bash
curl -X POST http://localhost:3000/webhooks/jira \
  -H 'content-type: application/json' \
  -d '{"providerEventId":"jira-demo-1","webhookEvent":"jira:issue_updated","generation":1,"forge":"gitlab","url":"https://gitlab.example.com/example/demo.git","issue":{"key":"DEMO-1","fields":{"issuetype":{"name":"Bug"},"status":{"name":"Ready for development"}}}}'
```

The returned workflow ID is `bugfix/DEMO-1/1`. After the fake harness creates, commits, and pushes its branch, copy the current commit SHA from the workflow status into `CURRENT_COMMIT_SHA`, then deliver CI, Sonar, and review success:

```bash
CURRENT_COMMIT_SHA=<current workflow commit SHA>

curl -X POST http://localhost:3000/webhooks/jenkins \
  -H 'content-type: application/json' \
  -d "{\"providerEventId\":\"jenkins-demo-1\",\"workflowId\":\"bugfix/DEMO-1/1\",\"attempt\":0,\"buildId\":\"demo-1\",\"commitSha\":\"${CURRENT_COMMIT_SHA}\",\"status\":\"success\"}"

curl -X POST http://localhost:3000/webhooks/sonarqube \
  -H 'content-type: application/json' \
  -d "{\"providerEventId\":\"sonar-demo-1\",\"workflowId\":\"bugfix/DEMO-1/1\",\"attempt\":0,\"commitSha\":\"${CURRENT_COMMIT_SHA}\",\"qualityGate\":\"passed\",\"findings\":[]}"

curl -X POST http://localhost:3000/webhooks/gitlab \
  -H 'content-type: application/json' \
  -d "{\"providerEventId\":\"gitlab-demo-1\",\"workflowId\":\"bugfix/DEMO-1/1\",\"attempt\":0,\"commitSha\":\"${CURRENT_COMMIT_SHA}\",\"requiredFeedbackResolved\":true}"
```

Inspect state through Restate's UI at `http://localhost:9070` or invoke the workflow's `status` shared handler using the URL shown by the registered deployment. The final state is `DONE`.

To simulate code-related failure, send `status: failed` with a bounded `log`; the parser creates a fingerprint and the fake harness writes a repair commit. Infrastructure phrases such as `agent was offline` lead to `HUMAN_REQUIRED` without resuming Codex.

## Real Codex mode

Set `HARNESS_MODE=codex` and configure Codex authentication before starting the app. You may retain fake Jira/GitLab adapters while testing Codex. The adapter uses `@openai/codex-sdk` to create and resume structured-output threads in the allocated workspace. It disables web search, uses read-only or workspace-write access by task, and never approves commands automatically. Use disposable credentials and an isolated execution host; local Git workspaces and the local Codex adapter are development backends, not production security boundaries.

Run the optional MCP adapter with `bun run mcp`. Its standalone provider intentionally returns empty data; production wiring should inject internal compact-context services.

## Restate replay tests

Run `bun run test:restate` on a Docker-capable host to execute the always-replay integration suite. The normal unit suite does not require Docker.
