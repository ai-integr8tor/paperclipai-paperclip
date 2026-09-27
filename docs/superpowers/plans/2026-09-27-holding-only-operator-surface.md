# Holding-Only Operator Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one Paperclip operator workspace per AgentSwarm holding even while a legacy business executor remains live.

**Architecture:** Add an operator-visibility field to Paperclip companies. The marker-scoped consolidator immediately projects only formal approval work to the holding and hides the legacy source; it leaves live runtime state untouched until terminal, when the existing full consolidation archives the source. AgentSwarm treats the new deferred result as a normal native-runtime wait.

**Tech Stack:** TypeScript, Drizzle/Postgres, Express, React, Vitest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-27-holding-only-operator-surface-design.md`

## Global Constraints

- The execution policy path is **PR**: this changes durable platform, database, API, and UI contracts.
- Preserve live run company IDs; do not create retries, replacement runs, or cross-company runtime aliases.
- Only exact AgentSwarm legacy-business and holding markers may use this migration.
- Formal Paperclip approval records are operator work; generic agent-authored issues are not.
- Never expose an operator-hidden company in operator navigation or automatic bootstrap selection.

## Review Focus

- Active source with no formal approval: hide it and return `runtime_deferred` without any unrelated moves.
- Formal approval linked to a live execution issue: move the formal approval
  and its approval comments only; retain the linked issue and link until the
  run is terminal, because the link API requires both endpoints to share a
  company.
- Repeated active-run reconciliation: no duplicate approval, no re-exposure, no dispatcher call.
- Hidden source queued/running lifecycle: runtime liveness remains active because company status stays `active`.
- Wrong source/target markers: no visibility or ownership change.

---

### Task 1: Add the operator-visibility company contract

**Files:**
- Modify: `packages/db/src/schema/companies.ts`
- Create: database migration in `packages/db/src/migrations/`
- Modify: `packages/shared/src/types/company.ts`
- Modify: company service/route serializers and tests as required

**Interfaces:**
- Produces: `Company.operatorVisible: boolean`, default `true`.

- [ ] **Step 1: Write failing schema/service tests for default-visible and persisted hidden companies.**

- [ ] **Step 2: Run the focused test and verify it fails because `operatorVisible` is absent.**

- [ ] **Step 3: Add non-null `operator_visible` with a `true` default, migration, and shared response type.**

- [ ] **Step 4: Run focused database and service tests; verify they pass.**

- [ ] **Step 5: Commit the contract change.**

### Task 2: Make active legacy consolidation operator-safe

**Files:**
- Modify: `server/src/services/companies.ts`
- Modify: `server/src/routes/companies.ts`
- Modify: `server/src/__tests__/companies-service.test.ts`
- Modify: `server/src/__tests__/companies-route-path-guard.test.ts`

**Interfaces:**
- Consumes: `operatorVisible` from Task 1.
- Produces: `runtime_deferred` consolidation result.

- [ ] **Step 1: Write failing tests covering an active source with a formal approval and approval comments, generic agent card, and runtime rows.**

- [ ] **Step 2: Run focused company tests and verify the current all-or-nothing deferral fails the assertions.**

- [ ] **Step 3: Implement marker-validated immediate formal-approval projection and source hiding; return `runtime_deferred` without moving runtime-owned state.**

- [ ] **Step 4: Update route validation/response tests for `runtime_deferred`; prove repeated calls are idempotent and wrong markers are rejected.**

- [ ] **Step 5: Run the focused company service and route suites; verify they pass.**

- [ ] **Step 6: Commit the active-execution consolidation behavior.**

### Task 3: Hide runtime-only legacy companies from operator UI

**Files:**
- Modify: `ui/src/context/CompanyContext.tsx`
- Modify: `ui/src/components/CompanySwitcher.tsx`
- Modify: `ui/src/components/SidebarCompanyMenu.tsx`
- Modify: `ui/src/pages/Companies.tsx`
- Modify: corresponding UI tests

**Interfaces:**
- Consumes: `Company.operatorVisible`.
- Produces: `operatorVisible === false` exclusion from all operator company navigation.

- [ ] **Step 1: Write failing UI tests for a hidden active company versus an ordinary active company.**

- [ ] **Step 2: Run the focused UI tests and verify hidden companies remain selectable before the change.**

- [ ] **Step 3: Filter bootstrap selection, switcher, sidebar menu, and management list by `operatorVisible !== false`.**

- [ ] **Step 4: Run focused UI tests and verify the hidden company cannot become selected while ordinary companies remain selectable.**

- [ ] **Step 5: Commit the operator navigation behavior.**

### Task 4: Update the AgentSwarm bridge contract and reconciler

**Files:**
- Modify: `src/server/paperclip/client.ts`
- Modify: `src/server/paperclip/bridge.ts`
- Modify: `src/trigger/tasks/business-reconciler.ts`
- Modify: `src/server/services/business/reconciler.ts`
- Modify: `test/paperclip-client.test.ts`
- Modify: `test/business-reconciler-factory.test.ts`

**Interfaces:**
- Consumes: `runtime_deferred` from Task 2.
- Produces: normal wait/no-repair behavior until native core returns `consolidated`.

- [ ] **Step 1: Write failing client/reconciler tests for `runtime_deferred` and a later `consolidated` response.**

- [ ] **Step 2: Run focused AgentSwarm tests and verify the old deferred discriminant is insufficient.**

- [ ] **Step 3: Update schemas, bridge allowlist, and reconciler branching so projection repair is only dispatched after `consolidated`.**

- [ ] **Step 4: Run focused AgentSwarm tests and verify no duplicate/native replacement work is created.**

- [ ] **Step 5: Commit the bridge compatibility change.**

### Task 5: Verify integration and deliver dependencies together

**Files:**
- Test: core focused company and UI suites
- Test: AgentSwarm `npm run build && npm run test:ci`

- [ ] **Step 1: Run core typecheck and all modified focused suites.**

- [ ] **Step 2: Run AgentSwarm build and full CI-equivalent suite from a clean worktree.**

- [ ] **Step 3: Inspect both diffs for runtime-owned row moves during `runtime_deferred`.**

- [ ] **Step 4: Publish the Paperclip core PR before, or atomically with, the dependent AgentSwarm PR; do not merge AgentSwarm first.**

- [ ] **Step 5: Verify deployed core contract, deployed AgentSwarm bridge, holding-only operator UI, and live executor continuity from read-only production evidence.**
