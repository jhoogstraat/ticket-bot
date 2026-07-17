# Local development

## Requirements

- Bun 1.3 or newer (mise selects Bun 1.3).
- Git with an initial commit and a reachable `main` branch.
- Docker for local Restate.
- Codex CLI login only when using `ADAPTER_MODE=real`.

## Setup and tests

```bash
cp .env.example .env
bun install
bun run format
bun run check
```

Environment variables are documented in `.env.example`. Fake integrations and harness are the defaults. `ADAPTER_MODE=real` requires `JIRA_BASE_URL`, `JIRA_TOKEN`, `GITLAB_BASE_URL`, and `GITLAB_TOKEN`. `HARNESS_MODE=codex` independently selects the real Codex CLI. Integration secrets are removed from the Codex child process.

## Start Restate and the application

```bash
docker compose up -d restate
bun run dev
```

Register the service endpoint:

```bash
curl -X POST http://localhost:9070/deployments \
  -H 'content-type: application/json' \
  -d '{"uri":"http://host.docker.internal:9080"}'
```

## Trigger the fake flow

Submit the bundled fake Jira ticket:

```bash
curl -X POST http://localhost:8080/JiraWebhook/receive \
  -H 'content-type: application/json' \
  -d '{"webhookEvent":"jira:issue_updated","generation":1,"issue":{"key":"DEMO-1","fields":{"issuetype":{"name":"Bug"},"status":{"name":"Ready for development"}}}}'
```

The returned workflow ID is `bug-fix/DEMO-1/1`. After the fake harness creates, commits, and pushes its branch, deliver CI and Sonar success:

```bash
curl -X POST http://localhost:8080/JenkinsWebhook/receive \
  -H 'content-type: application/json' \
  -d '{"workflowId":"bug-fix/DEMO-1/1","buildId":"demo-1","status":"success"}'

curl -X POST http://localhost:8080/SonarQubeWebhook/receive \
  -H 'content-type: application/json' \
  -d '{"workflowId":"bug-fix/DEMO-1/1","qualityGate":"passed","findings":[]}'
```

Inspect state through Restate's UI at `http://localhost:9070` or invoke the workflow's `status` shared handler using the URL shown by the registered deployment. The final state is `REVIEW_READY`.

To simulate code-related failure, send `status: failed` with a bounded `log`; the parser creates a fingerprint and the fake harness writes a repair commit. Infrastructure phrases such as `agent was offline` lead to `HUMAN_REQUIRED` without resuming Codex.

## Real Codex mode

Set `HARNESS_MODE=codex` and run `codex login` before starting the app. You may retain fake Jira/GitLab adapters while testing Codex. The adapter runs `codex exec --json` with a JSON output schema in the allocated workspace. It does not enable web search or browser access. Use disposable credentials and an isolated execution host; the local runner is a development backend, not a production security boundary.

Run the optional MCP adapter with `bun run mcp`. Its standalone provider intentionally returns empty data; production wiring should inject internal compact-context services.
