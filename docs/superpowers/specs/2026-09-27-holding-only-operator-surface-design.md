# Holding-Only Operator Surface Design

## Intent

AgentSwarm businesses owned by a holding must have one operator-facing
Paperclip workspace: the holding. An operator must never need to switch to a
per-business company to find or decide a real Paperclip approval.

The legacy per-business company is an implementation artifact, not an
operator-facing business. A live executor may retain it only as an internal
runtime scope until its current execution reaches a terminal state.

## Current problem

The existing consolidation endpoint defers *all* work while a legacy company
has a queued, scheduled, or running heartbeat. That protects a live executor,
but leaves the legacy company visible in the operator company picker and keeps
formal approvals scoped to the wrong operator workspace.

Moving a live heartbeat directly is unsafe. The running process retains
`run.companyId` and uses it for issue, event, workspace-operation, and
recovery writes. Moving that record would make those writes inconsistent with
the still-running process.

## Chosen design

### 1. Separate operator visibility from runtime status

Add `companies.operatorVisible`, a non-null boolean defaulting to `true`.
It means that a company can be active and usable by native runtime services
while hidden from all operator company navigation.

`operatorVisible = false` is only valid for the marker-validated legacy
AgentSwarm company handled by this consolidation endpoint. It is not a
general-purpose archive or access-control mechanism.

The UI must exclude operator-hidden companies from every company picker,
bootstrap selection, company-management list, and direct navigation surface.
The server retains the record in ordinary list responses for trusted platform
reconcilers and native runtime code; runtime behavior continues to use the
existing `status = active` checks unchanged.

### 2. Move formal operator work immediately

For a marker-validated source/holding pair, consolidation always moves:

- formal `approvals` and their `approvalComments`;
- their `issueApprovals` links; and
- any issue whose only purpose is the formal approval record, with its issue
  comments.

The implementation must not turn an agent-authored `in_review` issue into an
approval, and it must not move generic agent stage cards simply because they
contain words such as "decision" or "approval".

The source is marked operator-hidden before returning, including when it has
an active native run. This gives the operator the holding-only view
immediately while leaving executor-owned state unchanged.

### 3. Finish full consolidation only after native execution is terminal

If a source has a queued, scheduled, or running heartbeat after immediate
operator-work projection, return `runtime_deferred` and do not move agents,
runtime state, sessions, wake requests, heartbeat runs, events, watchdog
records, workspace operations, or generic issues.

After the source has no active heartbeat, perform the existing full
consolidation: move the marker-scoped operational issues, their comments,
projects, agents, runtime state, task sessions, wake requests, and all
remaining formal approval data, then archive the source.

The result is idempotent. Repeating it during a live execution neither
duplicates formal approvals nor re-exposes the legacy company.

## Safety invariants

1. Source and target must have the exact existing AgentSwarm business and
   holding markers; arbitrary companies cannot use this migration.
2. No live run or its runtime-owned records change company IDs.
3. A generic issue is never made into an operator approval.
4. Every formal approval visible to an operator belongs to the holding as soon
   as the migration endpoint returns successfully.
5. Hiding the source does not affect native queue/resume, recovery, budget,
   or run-event behavior; those continue to depend only on `status`.
6. The source is archived only after its native execution is terminal.

## Contract

`POST /api/companies/:companyId/consolidate-legacy-agentswarm-business`
returns one of:

- `consolidated` — all legacy runtime and operational state moved, source
  archived;
- `runtime_deferred` — formal operator work moved and source hidden, but
  native execution remains in the source; or
- `consolidated` for an already archived source (idempotent repeat).

The AgentSwarm client and reconciler must understand the renamed deferred
state, must not dispatch a replacement run, and must perform full projection
repair only after `consolidated`.

## Verification

Core tests must prove:

- active run returns `runtime_deferred`, moves a formal approval and its
  linked operator issue to the holding, hides the source, and leaves runtime
  rows in the source;
- generic agent-authored `in_review` cards remain in the hidden source;
- a terminal source fully consolidates and archives;
- repeated active-run calls are idempotent;
- unrelated companies cannot be hidden or consolidated.

UI tests must prove an active but operator-hidden company is excluded from
bootstrap selection, Company Switcher, sidebar company menu, and Companies
management page while an ordinary active company remains available.

AgentSwarm tests must prove that `runtime_deferred` does not schedule repair
or replacement work, and `consolidated` does.
