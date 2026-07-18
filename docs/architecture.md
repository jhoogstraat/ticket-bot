# Architecture

## Governing workflow

Ticket Bot implements the nine-stage bugfix loop as application-owned orchestration. Deterministic code owns queue capture, gates, mutations, retries, correlation, and handoff. Codex invocations are bounded workers for investigation, implementation, CI repair, and independent review; they never receive Jira, GitLab, Jenkins, or SonarQube credentials.

```mermaid
flowchart LR
    F["1. Capture fixed Jira filter queue"] --> I["2. Investigate each ticket independently"]
    I --> G{"3. Confidence and repository gate"}
    G -->|Blocked| H["Human request; no Jira or code mutation"]
    G -->|Actionable| C["4. Claim ticket and isolated branch"]
    C --> X["5. Implement approved fix"]
    X --> R{"6. Fresh adversarial review"}
    R -->|Revise| X
    R -->|Re-investigate| H
    R -->|Accept| M["7. Focused draft MR"]
    M --> P{"8. Latest pipeline terminal?"}
    P -->|Code failure| X
    P -->|Infrastructure/auth| H
    P -->|Success| J["9. Jira Ready to merge handoff"]
```

The adversarial review runs before the first push and merge request. A material review revision creates a local commit and repeats a fresh review before publication. After publication, every CI repair creates a new push and resets pipeline observation; Jira handoff still requires successful terminal results for the latest commit.

## Naming boundaries

- A **Restate Service** is an SDK-registered `restate.service(...)` handler collection, such as `BugFixQueue` or a webhook ingress service.
- A **Restate Workflow** is the keyed durable `BugFixWorkflow` execution.
- An **application operation** is injected, non-durable business logic such as `BugFixApplication` or `BugFixQueueCapture`. The workflow journals calls to it with `runApplicationStep`.
- The **webhook API** is the public HTTP boundary on `APP_PORT`; it verifies the raw request and forwards the normalized command to Restate with the provider delivery ID as its idempotency key.

Restate ingress is an internal network dependency of that API and must not be exposed publicly in production. Each provider callback includes its delivery ID, workflow ID, repair attempt, and commit SHA; the workflow ignores stale callbacks before resolving its durable promise.

## Stage contracts

| Skill stage        | Owning component                                                      | Enforced completion condition                                                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Load queue      | `BugFixQueue` and `BugFixQueueCapture`                                | Jira pagination reaches its last page; keys are deduplicated into one immutable captured result before any workflow is dispatched.                                                                                                                                                                                        |
| 2. Investigate     | `CodingHarness.analyzeTask`                                           | One read-only, schema-constrained analysis exists per key with Jira, repository, reproduction, scope, complexity, missing information, and confidence. Workflows are dispatched independently, so one blocked ticket cannot stop another.                                                                                 |
| 3. Confidence gate | `applyConfidenceGate`                                                 | Both confidences are High, files and observable verification are identified, no information is missing, and the resolved repository equals `ACTIONABLE_REPOSITORY_ID` (default `invoicing-outbound`). Otherwise the analysis records the exact human request and no Jira/code mutation occurs.                            |
| 4. Claim           | `JiraClient.claimIssue` and `WorkspaceManager`                        | The ticket is assigned to the authenticated Jira user, transitioned to In Progress, and has a unique `agent/<KEY>/<short-slug>` workspace.                                                                                                                                                                                |
| 5. Implement       | implementer harness and `BugFixApplication`                           | The approved analysis is supplied as a contract; only a bounded focused diff is accepted; validation succeeds; commit and push complete. Invalidated analysis stops rather than being forced through.                                                                                                                     |
| 6. Review          | fresh read-only `CodingHarness.review`                                | Before publication, the reviewer sees ticket evidence, analysis, complete base diff, and local verification. `Revise` returns findings to the implementer and requires another fresh review; `Re-investigate` stops.                                                                                                      |
| 7. MR              | `GitLabClient.createDraftMergeRequest`                                | Focused draft MR targets the configured default branch, is assigned to the current user, carries `LHIND`, and has What/Why/How/Verification/Scope plus `Fixes <KEY>`.                                                                                                                                                     |
| 8. Pipeline        | durable Jenkins/Sonar/GitLab-review promises and `repair-policy`      | Every push waits for callbacks keyed to the current cycle. Stale commit callbacks are ignored. Code failures get the smallest bounded repair; infrastructure, authentication, repeated, exhausted, unclear, Sonar, and unresolved required-review failures require a human. Elapsed time is never interpreted as success. |
| 9. Handoff         | `BugFixApplication.linkMergeRequestInJira` and `markJiraReadyToMerge` | Only an accepted latest state links the MR in Jira and transitions to Ready to merge. The bot never merges.                                                                                                                                                                                                               |

## System context

```mermaid
sequenceDiagram
    participant Caller
    participant Queue as BugFixQueue
    participant Jira
    participant WF as Per-ticket Restate workflow
    participant Runner
    participant Codex
    participant GitLab
    participant Jenkins
    participant Sonar

    Caller->>Queue: Jira filter URL
    Queue->>Jira: paginated open-bug search
    Queue->>Queue: freeze and deduplicate keys
    loop every captured key, independently
        Queue--)WF: start ticket generation
        WF->>Jira: fetch bounded evidence and history
        WF->>Runner: isolated repository snapshot
        Runner->>Codex: read-only investigation
        Codex-->>WF: structured analysis
        WF->>WF: deterministic confidence/scope gate
        alt blocked
            WF-->>Caller: exact human request
        else actionable
            WF->>Jira: assign current user, set status In Progress
            WF->>Codex: implement approved analysis
            WF->>Codex: fresh read-only adversarial review
            alt revise
                WF->>Codex: implementer addresses findings
                WF->>Codex: repeat fresh review
            end
            WF->>GitLab: push and create assigned LHIND draft MR
            Jenkins--)WF: terminal result for latest commit
            Sonar--)WF: bounded latest findings
            GitLab--)WF: required feedback resolution
            alt latest checks accepted
                WF->>Jira: link MR, set status Ready to merge
            end
        end
    end
```

## Evidence and artifacts

Jira normalization includes summary, description, acceptance criteria, expected/actual behavior, reproduction steps, environment, affected versions, recent comments, links, attachment metadata/classification, and recent status history. Context is bounded before it reaches a harness. Each investigation writes `ticket-analysis/<KEY>/ANALYSIS.md`; blocked documents include the missing evidence and concrete human action.

The analysis is also stored in durable workflow state so the implementer and fresh reviewer receive the same approved contract. Durable state contains identifiers, repository/workspace/branch, commit SHA, MR reference, analysis, stage, attempts, compact failure fingerprints, and token totals—not conversations or raw upstream payloads.

## Isolation, security, and durability

`ExecutionRunner` separates orchestration from execution. Each ticket uses a deterministic unique clone path and focused branch, preserving unrelated work. Paths are containment-checked; commands use argument arrays; time, output, changed-file, repair, and token context are bounded. The Codex child has workspace-only or read-only access as appropriate and has Jira/GitLab credentials removed.

Restate journals queue capture and each external side effect. Workflow identity is `bugfix/<ISSUE-KEY>/<generation>`. Jenkins callbacks for older SHAs are ignored; every repair or review revision advances the callback cycle. Production runners should use one Kubernetes Job/Pod per ticket with ephemeral storage, resource/network policy, and short-lived credentials behind the unchanged runner interface.

Authentication is an adapter concern. HTTP adapters use the authenticated service identity; an interactive Microsoft Entra deployment must translate an expired/missing session into a human-authentication request and resume the journaled operation after login. Product code must never be changed to conceal authentication or infrastructure failures.
