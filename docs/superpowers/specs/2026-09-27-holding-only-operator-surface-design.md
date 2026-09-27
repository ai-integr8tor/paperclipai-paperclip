# Holding-Only Operator Surface Design

## Intent

AgentSwarm businesses owned by a holding must have one operator-facing
Paperclip workspace: the holding. An operator must never need to switch to a
per-business company to find or decide a real Paperclip approval.

The legacy per-business company is an implementation artifact, not an
operator-facing business. Its native execution and issue records remain in
that internal runtime scope for their full lifecycle.

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

For a marker-validated source/holding pair, consolidation always projects:

- formal `approvals` into the holding inbox through
  `approvals.operatorCompanyId`.

The approval, its comments, and `issueApprovals` links retain source ownership
because agents, native heartbeat gates, and hire-agent logic query their
original company. The holding approval card is the operator's decision
surface. All source issues and their comments remain with the runtime.

New source-owned approvals inherit the same holding projection at insertion;
the operator must not wait for another consolidation pass. Holding inbox,
attention, dashboard, and sidebar counts use the projected approval scope.

The implementation must not turn an agent-authored `in_review` issue into an
approval, and it must not move generic agent stage cards simply because they
contain words such as "decision" or "approval".

The source is marked operator-hidden and points to its holding via
`operatorCompanyId` before returning, including when it has an active native
run. Existing source URLs and saved selections redirect to the holding.

### 3. Preserve native execution ownership

Return `runtime_deferred` after projecting the operator surface. Do not move
agents, runtime state, sessions, wake requests, heartbeat runs, events,
watchdog records, workspace operations, or issues, regardless of the current
run status. The source company remains active for native work.

The result is idempotent. Repeating it during any execution neither
duplicates formal approvals nor re-exposes the legacy company.

## Safety invariants

1. Source and target must have the exact existing AgentSwarm business and
   holding markers; arbitrary companies cannot use this migration.
2. No live run or its runtime-owned records change company IDs.
3. A generic issue is never made into an operator approval.
4. Every formal approval visible to an operator appears in the holding inbox
   as soon as the migration endpoint returns successfully.
5. Hiding the source does not affect native queue/resume, recovery, budget,
   or run-event behavior; those continue to depend only on `status`.
6. The source remains active as a runtime container and is never an operator
   workspace.

## Contract

`POST /api/companies/:companyId/consolidate-legacy-agentswarm-business`
returns one of:

- `runtime_deferred` — formal operator work projected and source hidden, while
  native execution remains in the source; or
- `consolidated` for an already archived source from an older migration
  (idempotent repeat).

The AgentSwarm client and reconciler must understand the renamed deferred
state and must not dispatch replacement or repair work for an active source.

## Verification

Core tests must prove:

- active run returns `runtime_deferred`, exposes the source approval in the
  holding inbox, hides the source, and leaves approval ownership, runtime
  rows, and issue-approval links in the source;
- generic agent-authored `in_review` cards remain in the hidden source;
- a terminal source remains an internal runtime container;
- repeated calls are idempotent;
- unrelated companies cannot be hidden or consolidated.

UI tests must prove an active but operator-hidden company is excluded from
bootstrap selection, Company Switcher, sidebar company menu, and Companies
management page while an ordinary active company remains available.

AgentSwarm tests must prove that `runtime_deferred` does not schedule repair
or replacement work, and `consolidated` does.
