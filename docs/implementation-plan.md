# Implementation plan

## Phase 1: Project scaffold and domain models

- Scope: strict TypeScript, environment validation, ticket/workflow/harness/CI/MR types, trusted repository-target contract, errors.
- Deliverables: build/lint/test configuration and documented boundaries.
- Tests: repository URL authorization.
- Exit: clean build with no untyped external inputs.
- Risks: evolving SDK contracts. Pin and test dependency upgrades.

Status: complete.

## Phase 2: Restate workflow and fake adapters

- Scope: durable ticket-generation workflow, callback promises, state query, fake Jira/GitLab/harness.
- Deliverables: fake webhook-to-draft-MR path waiting for CI.
- Tests: webhook validation, workflow identity, integration-style vertical slice.
- Exit: restart-safe state and deterministic idempotency boundaries.
- Risks: a full Restate-container replay test remains to be added in CI.

Status: initial slice complete.

## Phase 3: Local Git workspaces and Codex integration

- Scope: isolated clone/branch, path/timeout/output controls, schema-driven Codex SDK start/resume/review.
- Deliverables: local Git workspace boundary, fake harness, real Codex adapter, Docker execution contract.
- Tests: harness schema validation and real Git integration.
- Exit: fake flow passes and real mode can start with valid credentials.
- Risks: Codex JSON event fields can evolve; keep parsing tolerant and output schema strict.

Status: initial slice complete; container resource isolation remains.

## Phase 4: Jira and forge integration

- Scope: production auth, paginated fixed filter queue, attachment download/classification, deterministic confidence-gate record, Jira claim/transitions/MR link.
- Deliverables: API clients with short-lived credentials and idempotent mutations.
- Tests: pagination snapshots, transition idempotency, rate limiting, redaction.
- Exit: every ticket in the captured queue has one independent workflow; blocked tickets do not block others.
- Risks: custom Jira fields/status names and forge authentication.

Status: fixed paginated queue capture, current-user claim, In Progress transition, MR link, Ready-to-merge transition, current-user MR assignment, and `LHIND` label contracts are implemented. Interactive Entra renewal and attachment-body download remain deployment adapter work.

## Phase 5: Jenkins and SonarQube callbacks

- Scope: signed webhook verification, branch/SHA/MR correlation, test-report enrichment, changed-file Sonar API adapter.
- Deliverables: no polling, compact callback payloads, stale-callback rejection.
- Tests: signatures, replay, large logs, category fixtures, quality filters.
- Exit: latest commit has authoritative terminal statuses.
- Risks: Jenkins plugin payload diversity and delayed callbacks.

Status: callback services and deterministic compactors are implemented; signatures and real clients remain.

## Phase 6: Repair loop

- Scope: bounded resume context, attempt/fingerprint policy, revalidation/push, infrastructure escalation.
- Deliverables: maximum three repairs and per-push CI wait reset.
- Tests: repeated failure, unchanged commit, limit, infrastructure, human input.
- Exit: no policy decision is delegated to Codex.
- Risks: defining “meaningful change” more precisely than commit equality.

Status: initial Jenkins repair loop complete.

## Phase 7: Independent review

- Scope: fresh read-only session, base diff, tests, CI, Sonar, actionable verdict, Jira ready-to-merge handoff.
- Deliverables: review-ready state without merge authority.
- Tests: blocking finding, unrelated diff, failed quality gate.
- Exit: accepted fixes have no unresolved important/blocking feedback.
- Risks: reviewer consistency and diff size; large diffs should escalate before review.

Status: fresh adversarial review, implementer revision, fresh pipeline/review reset, and Jira Ready-to-merge handoff are implemented.

## Phase 8: Kubernetes runner and production hardening

- Scope: one Job/Pod per ticket, network/secret/resource policy, audit retention, OpenTelemetry, HA Restate, disaster recovery.
- Deliverables: Kubernetes executor that owns its workspace and coding runtime, deployment manifests, SLO dashboards.
- Tests: pod escape controls, cancellation/cleanup, restart/replay, credential expiry, load and chaos tests.
- Exit: production security review and operational runbook approved.
- Risks: untrusted build execution, dependency downloads, artifact retention, and cost controls.

Status: planned.
