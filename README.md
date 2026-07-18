# Ticket Bot

Ticket Bot is an initial vertical slice of a durable, token-efficient bug-resolution platform. Jira, GitLab, Jenkins, SonarQube, retry policy, state, and context reduction are ordinary TypeScript. Codex is used only for repository investigation, editing, repair, and independent review.

The default configuration uses fake Jira, GitLab, and Codex adapters while exercising a real isolated Git workspace. The same workflow can select the Codex SDK with `HARNESS_MODE=codex` and HTTP Jira/GitLab adapters with `ADAPTER_MODE=real`.

## What works

- Restate workflow identity and durable state per ticket generation.
- The Restate SDK owns the HTTP/2 service endpoint, including bidirectional protocol support.
- Paginated, deduplicated, fixed Jira-filter queues with independent per-ticket dispatch.
- Normalized, bounded Jira context.
- Read-only structured investigation and deterministic High/High confidence gate before Jira or code mutation.
- Per-ticket clone and branch with path containment checks.
- Provider-neutral coding harness with fake and official Codex SDK implementations.
- Focused-diff validation, commit, push, and draft merge request creation.
- Jenkins callback compaction, fingerprinting, classification, and bounded repair loop.
- Changed-file/new-code Sonar filtering and callback.
- Fresh adversarial review with revise/re-run cycles and Jira Ready-to-merge handoff; no automatic merge.
- Narrow MCP tools for optional progressive context.
- Structured token accounting and telemetry extension points.

## Quick start

```bash
bun install
bun run format
bun run check
docker compose up -d restate
bun run dev
```

Register the endpoint and invoke the fake flow using the commands in [local development](docs/local-development.md). The repository must have an initial commit because each run starts from an isolated Git clone.

For a guided first read, start with the [reading guide](docs/reading-guide.md). See also the [architecture](docs/architecture.md), [code tour](docs/code-tour.md), and [implementation plan](docs/implementation-plan.md).
