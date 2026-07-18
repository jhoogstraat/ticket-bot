# Reading guide

This is the shortest path to understanding Ticket Bot. Read it lifecycle-first: begin with what the system does, then follow one ticket through orchestration, application operations, domain policy, agent execution, and external adapters. For deeper detail, see [architecture.md](architecture.md) and [code-tour.md](code-tour.md).

## Business lifecycle

Ticket Bot turns a captured Jira bug into a reviewed draft merge request that is ready for a human to merge:

1. Capture and freeze the issues returned by a Jira filter.
2. Start one durable workflow per ticket so tickets progress independently.
3. Gather bounded Jira and repository evidence, then ask the coding harness to investigate.
4. Apply a deterministic confidence and repository gate. Unclear or out-of-scope work stops with a concrete human request and no mutation.
5. Claim an actionable ticket, create an isolated workspace and focused branch, implement the approved analysis, and validate the change.
6. Run a fresh adversarial review. Material findings return to implementation and require another review.
7. Push the accepted change and create a focused draft merge request.
8. Wait durably for Jenkins, SonarQube, and GitLab review results for the latest commit. Eligible code failures receive bounded repair attempts; infrastructure, authentication, repeated, exhausted, or unclear failures require a human.
9. When the latest checks are accepted, link the merge request in Jira and move the ticket to Ready to merge. The bot never merges it.

```mermaid
flowchart TD
    Q["Capture fixed Jira queue"] --> W["Start one durable workflow per ticket"]
    W --> I["Investigate bounded ticket and repository evidence"]
    I --> G{"Confidence and repository gate"}
    G -->|Blocked| H["Human required<br/>no Jira or code mutation"]
    G -->|Actionable| C["Claim ticket and create isolated branch"]
    C --> X["Implement and validate approved fix"]
    X --> R{"Fresh adversarial review"}
    R -->|Revise| X
    R -->|Re-investigate| H
    R -->|Accept| M["Push and create draft merge request"]
    M --> P{"Latest CI and review results"}
    P -->|Repairable code failure| X
    P -->|Human intervention needed| H
    P -->|Accepted| J["Link MR and set Jira Ready to merge"]
```

## Canonical file reading order

Follow this order for an end-to-end mental model. On a first pass, read public types and top-level methods before implementation details.

1. [`src/server.ts`](../src/server.ts) — composition root: which concrete services, harnesses, runners, adapters, workflows, and webhooks make up the application.
2. [`src/restate/services/bugfix-queue.ts`](../src/restate/services/bugfix-queue.ts) and [`src/application/bugfix-queue-capture.ts`](../src/application/bugfix-queue-capture.ts) — how a Jira filter becomes one immutable, deduplicated batch of independent ticket workflows.
3. [`src/restate/workflows/bugfix/definition.ts`](../src/restate/workflows/bugfix/definition.ts) — the thin canonical coordinator for durable phase ordering and terminal outcomes.
4. [`src/restate/workflows/bugfix/phases/initial-fix.ts`](../src/restate/workflows/bugfix/phases/initial-fix.ts), [`src/restate/workflows/bugfix/phases/review.ts`](../src/restate/workflows/bugfix/phases/review.ts), [`src/restate/workflows/bugfix/phases/ci-repair.ts`](../src/restate/workflows/bugfix/phases/ci-repair.ts), and [`src/restate/workflows/bugfix/phases/completion.ts`](../src/restate/workflows/bugfix/phases/completion.ts) — the readable lifecycle phases called by the coordinator.
5. [`src/domain/workflow.ts`](../src/domain/workflow.ts) — the durable state, grouped stage types, transition helpers, and callback contracts.
6. [`src/application/bugfix-application.ts`](../src/application/bugfix-application.ts) — ticket-level operations called by the workflow, without Restate concerns.
7. [`src/domain/analysis.ts`](../src/domain/analysis.ts) and [`src/restate/workflows/bugfix/phases/repair-policy.ts`](../src/restate/workflows/bugfix/phases/repair-policy.ts) — the deterministic decisions about whether work may begin or a CI repair may continue.
8. [`src/domain/harness.ts`](../src/domain/harness.ts) — the provider-neutral contract for investigation, implementation, repair, revision, and independent review.
9. [`src/harness/codex-harness.ts`](../src/harness/codex-harness.ts), [`src/harness/harness-prompts.ts`](../src/harness/harness-prompts.ts), and [`src/harness/harness-result-parser.ts`](../src/harness/harness-result-parser.ts) — how bounded Codex processes receive prompts and return validated structured results.
10. [`src/runner/execution-runner.ts`](../src/runner/execution-runner.ts) and [`src/runner/workspace-manager.ts`](../src/runner/workspace-manager.ts) — execution isolation, repository workspaces, branches, validation, commits, and pushes.
11. [`src/integrations`](../src/integrations) and [`src/webhooks`](../src/webhooks) — external API mechanics and delivery of CI/review callbacks into the durable workflow.

For a narrower question, jump directly to the matching responsibility below rather than reading every adapter.

## Responsibility map

| Question                                      | Start here                                                                                                        | Responsibility                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| How does the process start?                   | [`src/server.ts`](../src/server.ts)                                                                               | Runtime wiring and Restate endpoint registration                               |
| How are tickets selected?                     | [`src/restate/services/bugfix-queue.ts`](../src/restate/services/bugfix-queue.ts)                                 | Fixed queue capture and independent workflow dispatch                          |
| What happens next for one ticket?             | [`src/restate/workflows/bugfix/definition.ts`](../src/restate/workflows/bugfix/definition.ts)                     | Ordering, durability, retries, waits, and state transitions                    |
| How is one operation performed?               | [`src/application/bugfix-application.ts`](../src/application/bugfix-application.ts)                               | Jira evidence, workspaces, harness calls, validation, publication, and handoff |
| Why was a ticket blocked?                     | [`src/domain/analysis.ts`](../src/domain/analysis.ts)                                                             | Analysis contract and deterministic confidence/repository gate                 |
| Why was CI repaired or stopped?               | [`src/restate/workflows/bugfix/phases/repair-policy.ts`](../src/restate/workflows/bugfix/phases/repair-policy.ts) | Bounded repair eligibility and stop conditions                                 |
| What may the coding agent do?                 | [`src/domain/harness.ts`](../src/domain/harness.ts)                                                               | Agent-facing operation and result boundaries                                   |
| How is Codex invoked safely?                  | [`src/harness/codex-harness.ts`](../src/harness/codex-harness.ts)                                                 | Bounded subprocess sessions, permissions, timeouts, and schemas                |
| How are repositories isolated?                | [`src/runner`](../src/runner)                                                                                     | Execution abstraction, containment, workspaces, and Git operations             |
| How do Jira, GitLab, Jenkins, and Sonar work? | [`src/integrations`](../src/integrations)                                                                         | Replaceable external-system adapters                                           |
| How do asynchronous results resume work?      | [`src/webhooks`](../src/webhooks)                                                                                 | Validation, correlation, and resolution of durable callback promises           |

## Key terms

- **Captured queue** — the immutable, deduplicated set of Jira keys returned by one complete paginated filter read. Later filter changes do not alter an active run.
- **Per-ticket workflow** — one Restate workflow identified as `bugfix/<ISSUE-KEY>/<generation>`. It owns durable ordering and state for exactly one ticket attempt.
- **Generation** — an explicit run number that allows a later attempt for the same Jira key without colliding with an earlier workflow.
- **Journaled operation** — an external or non-deterministic action wrapped in `ctx.run`; Restate records its result so recovery does not blindly repeat completed work.
- **Durable state** — the compact workflow record containing identifiers, approved analysis, workspace and commit data, MR reference, attempts, token totals, and current stage—not full conversations or raw upstream payloads.
- **Durable callback** — a Restate promise resolved later by a Jenkins, SonarQube, or GitLab webhook. Callbacks are correlated to the current repair cycle and commit.
- **Coding harness** — the provider-neutral interface used for investigation, implementation, repair, revision, and fresh review. Codex is one adapter behind it.
- **Approved analysis** — the structured investigation result that passed the deterministic gate and becomes the implementation and review contract.
- **Confidence gate** — domain policy requiring high root-cause and fix confidence, identified files and verification, no missing information, and the configured actionable repository.
- **Adversarial review** — a fresh read-only agent session that independently examines the ticket evidence, analysis, complete diff, and verification before publication.
- **Repair cycle** — one bounded attempt to correct an eligible code-related CI failure; a new push advances callback correlation to the latest commit.
- **Human required** — a deliberate terminal outcome for missing evidence, invalidated analysis, infrastructure/authentication issues, exhausted or repeated failures, unresolved review findings, or other unsafe-to-automate conditions.
- **Handoff** — linking the accepted draft MR in Jira and transitioning the ticket to Ready to merge. Merge authority remains with a human.

## Reading heuristic

Keep the dependency direction in mind: the workflow decides **when**, the service coordinates **what**, domain policy decides **whether**, the harness and runner define **how work executes**, and adapters define **how external systems are contacted**. When behavior is surprising, start at the workflow transition and follow only the called operation downward.
