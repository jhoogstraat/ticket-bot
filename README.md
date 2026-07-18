<p align="center">
  <img src="docs/assets/bug-bot-icon.png" alt="Bug Bot icon" width="180">
</p>

<h1 align="center">Bug Bot</h1>

<p align="center">
  <strong>From Jira bug to reviewed draft merge request—durably, safely, and without babysitting.</strong>
</p>

## What

Bug Bot is a durable bug-resolution pipeline. It picks up Jira tickets, investigates the problem, implements a focused fix in an isolated workspace, validates the result, runs an independent review, and opens a draft merge request.

It automates the repetitive path to **ready for review**. The final merge always stays with a human.

## Why

Writing code is only one part of fixing a production bug. The hard part is making the entire process reliable: retries, crashes, stale callbacks, incomplete tickets, scope creep, failed validation, and unsafe handoffs.

Bug Bot wraps the coding agent in deterministic TypeScript and durable Restate orchestration. Completed work survives restarts, side effects stay bounded, and uncertain fixes stop before they can mutate Jira or the repository.

## How

```text
Jira → investigate → confidence gate → isolated branch → implement
     → validate → independent review → draft MR → human merge
```

- **Restate** owns durable execution, retries, and workflow identity.
- **Codex** is a bounded worker for investigation, implementation, repair, and review.
- **TypeScript** owns policy, validation, integrations, and every irreversible decision.
- **Jira, GitLab, Jenkins, and SonarQube** remain replaceable adapters around the workflow.

No automatic merge. No credentials handed to the coding agent. No forcing low-confidence fixes through the pipeline.

## Quick start

```bash
bun install
bun run check
docker compose up -d restate
bun run dev
```

The default setup uses fake Jira, GitLab, and Codex adapters while exercising a real isolated Git workspace. Follow [local development](docs/local-development.md) to register the Restate endpoint and run the complete fake flow.

Use `HARNESS_MODE=codex` for the Codex SDK and `ADAPTER_MODE=real` for HTTP Jira and GitLab adapters.

## Go deeper

- [Architecture](docs/architecture.md)
- [Code tour](docs/code-tour.md)
- [Reading guide](docs/reading-guide.md)
- [Implementation plan](docs/implementation-plan.md)
