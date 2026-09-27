# Decision Context: briefs, relations, and readable task references

Date: 2026-09-27
Status: Design approved in conversation; awaiting written-spec review

## 1. Problem

Board operators see many pending questions and decisions from agents, in the
experimental **Decisions** surface (`/decisions`, `ui/src/pages/WhatNeedsMe.tsx`)
and inside task threads. Each item shows only an agent-written `title` and a
free-form `summary`/`body`. The operator cannot tell from the card:

- what work is in progress and who asked for it;
- why the agent stopped here and why the decision belongs to a human;
- what each option leads to;
- how the task relates to other agents' work (parent task, siblings, blockers,
  other pending decisions in the same tree);
- what bare task identifiers such as `CAT-61` refer to.

Most of the relational data already exists (`issues.parentId`, `goalId`,
`projectId`, `createdByAgentId`, issue relations). Only the narrative ("why I
stopped") is lost when the agent's run ends.

## 2. Goals and non-goals

**Goals**

- A human can decide from the expanded card, without opening the task, in the
  large majority of cases.
- The same context appears in the Decisions feed and in the task thread.
- Every task mention in decision surfaces shows the task name and, on hover, a
  summary of what the task is for.

**Non-goals (this spec)**

- System-generated feed items (failed runs, budget alerts, agent errors,
  blocker/review attention). They keep their current rendering.
- Server-side LLM summarization. Paperclip's server does not call models.
- Historical snapshots of relations at creation time. Relations are live.
- Measuring brief quality.

## 3. Decisions made during design

| Question | Decision |
|---|---|
| Who writes the narrative | The originating agent, at creation time |
| Scope | Issue-thread interactions (all kinds), standalone decisions (incl. bundles), board approvals |
| Enforcement | Optional; visual "no agent context" marker; per-company flag to require it for human-facing items, off by default |
| Relations shown | Origin chain + siblings, blockers and impact, related pending decisions, recent activity |
| Storage approach | Dedicated `brief jsonb` column + lazily loaded context endpoint (approach A) |
| Hover summary source | New `issues.summary` field, falling back to a derived excerpt of `description` |

## 4. Data model and contracts

### 4.1 `DecisionBrief` (new shared type)

`packages/shared/src/types/decision-brief.ts` and a zod `decisionBriefSchema`
in `packages/shared/src/validators/decision-brief.ts`, both exported from the
package index.

```ts
interface DecisionBrief {
  version: 1;
  whatIsHappening: string; // 1..1200 chars: work in progress and who asked for it
  whyStopped: string;      // 1..1200 chars: what blocked, why the decision is not the agent's
  whatWeNeed: string;      // 1..1200 chars: the decision and the consequence of each option
  recommendation?: string; // 1..400 chars
  relatedWork?: Array<{    // max 8; links the system cannot see on its own
    issueId?: string;      // uuid
    agentId?: string;      // uuid
    note: string;          // 1..300 chars
  }>;
}
```

All strings are trimmed. `issueId`/`agentId` values must belong to the same
company; unknown or foreign ids are rejected with 422 by the server.

### 4.2 Schema changes (one migration via `pnpm db:generate`)

- `issue_thread_interactions.brief jsonb NULL`
- `decisions.brief jsonb NULL`
- `approvals.brief jsonb NULL`
- `issues.summary text NULL` (max 600 chars, up to 3 paragraphs; enforced in the
  validator, not the DB)
- `companies.require_decision_brief boolean NOT NULL DEFAULT false`

No indexes are needed; nothing filters on these columns.

### 4.3 Write paths

- `createIssueThreadInteractionSchema` (`packages/shared/src/validators/issue.ts`):
  optional `brief` on every union branch. Payload `version` stays `1` because
  the field is additive and top-level, not inside `payload`.
- Decision create body (`server/src/routes/decisions.ts`, `createSchema` and
  each decision nested in `bundleSchema`): optional `brief`.
- Approval create: optional top-level `brief`.
- Issue create/update validators: optional `summary`. The field joins the list
  of tracked fields in the existing issue update activity log entry.
- CLI: `paperclipai issue create|update --summary <text>`.

A malformed `brief` or `summary` fails zod validation → **400** (the error
handler's standard `Validation error` response). A `relatedWork` id that is
unknown or belongs to another company → **422**. A missing brief is accepted.
Idempotent retries compare only the fields they compare today; `brief` is
narrative and does not take part in idempotency equivalence.

### 4.4 Enforcement flag

When `companies.requireDecisionBrief` is `true`, creating any of the following
without a `brief` returns **422** with the message
`"This company requires a decision brief for human-facing questions. Add brief.whatIsHappening, brief.whyStopped and brief.whatWeNeed."`:

- an interaction whose effective resolver policy is `human_only`, or that has an
  `addresseeUserId`;
  - Server-generated interactions (tool-gateway confirmations and elicitations,
    the onboarding opening question, connection/secret/tool-access cards) are
    exempt in phase 1.
- any standalone decision;
- any approval created through `POST /companies/:companyId/approvals` (server-generated
  approvals — agent hire requests, budget overrides, tool-gateway approvals — are
  exempt in phase 1).

Interactions addressed to an agent (`addresseeAgentId`) or left to the
default `anyone` audience are exempt. The flag is editable by board users in
company settings, and changing it writes an activity log entry.

### 4.5 Read paths

- `IssueThreadInteraction`, `Decision`, `Approval` types expose
  `brief: DecisionBrief | null`.
- `Issue` exposes `summary: string | null`.
- `AttentionItem` gains `hasBrief: boolean` and
  `briefExcerpt: string | null` (first ~200 chars of `whyStopped`). For source
  kinds outside scope, `hasBrief` is `false` and `briefExcerpt` is `null`. The
  full brief is not added to the list payload.

## 5. Decision context endpoint

### 5.1 Route

`GET /api/companies/:companyId/decision-context?sourceKind=<kind>&sourceId=<id>`

- `sourceKind` ∈ `issue_thread_interaction | decision | approval`; anything
  else → **400**.
- `assertCompanyAccess`. Board users and agents of the same company may read.
- The source must belong to `companyId`; otherwise **404** (no existence leak).
- Read-only; no activity log entry.

### 5.2 Service

New file `server/src/services/decision-context.ts` (`decisionContextService(db)`),
kept out of `attention.ts`. It resolves the source to an **origin issue**:
`interaction.issueId`, `decision.originIssueId`, or the approval's first linked
issue. An approval with no linked issue returns only `source`, `brief` and
`referencedIssues`; every relation section is empty.

### 5.3 Response

```ts
interface IssueRef {
  id: string; identifier: string | null; title: string;
  summary: string | null;          // issues.summary or derived description excerpt
  status: IssueStatus;
  assignee: ActorRef | null;
}

interface DecisionContext {
  source: { kind; id; createdAt; originAgent: AgentRef | null };
  brief: DecisionBrief | null;
  originIssue: IssueRef | null;
  chain: {
    goal: { id; title } | null;
    project: { id; name } | null;
    ancestors: Array<IssueRef & { requestedBy: ActorRef | null }>; // root first, max 10
  };
  siblings: {
    parent: IssueRef | null;
    items: IssueRef[];             // max 12, origin included and flagged, ordered by status
    totals: Partial<Record<IssueStatus, number>>;
  };
  blockers: {
    blockedBy: IssueRef[];
    blocks: IssueRef[];
    downstreamCount: number;       // transitive dependents, depth ≤ 5
  };
  relatedDecisions: Array<{ kind; id; title; issue: IssueRef; createdAt }>; // max 10
  recentActivity: Array<{ kind: "comment" | "status_change"; actor: ActorRef | null; excerpt: string; at: string }>; // last 3
  referencedIssues: Record<string, IssueRef>; // identifier → ref, max 30
  partial: boolean;
  failedSections: Array<"chain" | "siblings" | "blockers" | "relatedDecisions" | "recentActivity" | "referencedIssues">;
}
```

### 5.4 Computation

| Section | Query |
|---|---|
| chain | One recursive CTE up `parent_id` (pattern at `issues.ts` `WITH RECURSIVE ancestors`), capped at 10 levels, plus a batched goal/project lookup. `requestedBy` = `createdByAgentId` or `createdByUserId`. The existing `getAncestors` is not reused because it issues one query per level. |
| siblings | `WHERE company_id = ? AND parent_id = origin.parent_id`, limit 12, plus a grouped count by status. |
| blockers | Existing batched `getIssueRelationSummaryMap`; `downstreamCount` via recursive CTE over relations, depth ≤ 5. |
| relatedDecisions | Descendants CTE from the chain root. Pending interactions (scope rules of the feed: addressed to humans or to non-invokable agents), open decisions, and pending approvals whose issue is in that subtree, excluding the current source. |
| recentActivity | Last 3 comments or status changes on the origin issue, plain-text excerpts of 200 chars. |
| referencedIssues | Pure `extractIssueIdentifiers(texts: string[])` in `packages/shared`, using `ISSUE_REFERENCE_IDENTIFIER_RE` and excluding case identifiers (`PAP-C7`), over title, summary, prompt, question prompts, option labels/descriptions, decision body and brief fields. Resolved with one `inArray` query scoped to the company. |

`IssueRef.summary` = `issues.summary`, or else the first 3 paragraphs of
`description` stripped of markdown and capped at ~600 chars.

Every section runs independently. A thrown section yields its empty value,
adds its name to `failedSections`, sets `partial: true`, and is logged
server-side. The endpoint returns 200 unless the source itself cannot be
loaded.

**Budget:** a fixed number of queries (~8) regardless of tree depth or number
of mentions. A test asserts this.

## 6. UI

Copy is English and uses the canonical term *task* (DESIGN.md principle 7).
All visual values come from tokens in `ui/src/index.css`, and the change must
pass `pnpm check:token-gates`.

### 6.1 Data hook

`useDecisionContext(sourceKind, sourceId, { enabled })` in `ui/src/api/` and
`ui/src/lib/queryKeys.ts`, with `staleTime: 30_000`. It is enabled only when
the card is expanded or rendered in a thread. On success it seeds
`queryKeys.issues.detail(identifier)` for each `referencedIssues` entry so
inline mentions do not fetch individually. The cache is invalidated when
`LiveUpdatesProvider` receives an event for the origin issue.

### 6.2 Collapsed feed row (`AttentionQueueRow`)

- The second line shows `briefExcerpt`, falling back to the current
  `attentionDetailLine(item) ?? item.whyNow`.
- When `!hasBrief` and the item is in scope, a neutral muted badge
  **"no agent context"**.

### 6.3 `DecisionContextPanel` (new, single component)

Used in the feed's expanded row, `IssueThreadInteractionCard`, and
`DecisionCard`. Props: `sourceKind`, `sourceId`, `brief` (rendered immediately
from the already-loaded source), `relationsDefaultOpen`.

Order is brief, then relations, then the existing resolver/options.

- **Brief.** Overline-labelled sections *What's happening*, *Why it stopped*,
  *What we need*, then *Recommendation*. No per-section boxes (DESIGN.md
  principle 4).
- **No brief.** The line "The agent didn't include context for this decision.
  Relations below are computed by Paperclip." Relations open by default.
- **Relations** (a collapsible "Context & relations"):
  - chain breadcrumb with `requestedBy` names;
  - sibling list with `StatusGlyph`, assignee and totals ("CTO asked for 4
    tasks under CAT-50: 2 done, 1 active, 1 waiting"), origin flagged "this";
  - *Waiting on this decision*: `blocks` plus "+N more downstream";
  - *Also pending in this tree*: `relatedDecisions`, each linking to its feed
    item;
  - *Recent*: `recentActivity`.
- **`relatedWork` merge.** When `issueId` matches a computed row, the agent's
  note renders beneath that row (muted, italic). Otherwise it goes under
  "Agent notes".
- **Loading.** A three-line skeleton for relations only.
- **Partial.** Each failed section shows "Couldn't load <section>" with a
  *Retry* action that refetches the context.

`relationsDefaultOpen` is `true` in the Decisions feed and `false` inside the
task thread, where the chain is already implied. The brief is always visible.

### 6.4 Readable task references

- **`InlineReferenceText`** (new): renders plain-text fields (interaction
  title/summary/prompt, question prompts, option labels/descriptions, brief
  fields) through the same tokenizer as `ui/src/lib/issue-reference.ts`,
  without the full markdown pipeline.
- **`MarkdownIssueLink` `showTitle` prop.** Renders
  `CAT-61 · <title truncated ~40 chars>`. It is on in decision surfaces
  (`MarkdownBody` gains a pass-through prop) and off in ordinary comments.
- **Hover.** Inline mentions are wrapped in `IssueLinkQuicklook`.
  `IssueQuicklookCard` gains `variant="extended"`, which adds a
  "with <assignee> · part of <parent>" line and shows `summary` (or the
  derived description) up to ~600 chars instead of the 4-line clamp. Existing
  open-delay and keyboard behaviour is kept.

### 6.5 Task page

`IssueDetail` shows `summary` under the title, editable inline. The empty
placeholder reads "Add a short summary — shown when this task is mentioned."
Company settings gain a "Require decision briefs for human-facing questions"
switch bound to `requireDecisionBrief`.

## 7. Agent skill and docs

`skills/paperclip/SKILL.md` gains a **Decision briefs** subsection after the
interaction kinds table:

- **When a brief is required.** For any question or decision a human may
  answer (default `anyone`, `human_only`, `addresseeUserId`), every standalone
  decision, and every approval requested through the approvals API. It is optional when the question is addressed
  to an agent.
- **What the three paragraphs contain.**
  - `whatIsHappening`: the work in progress, who requested it, and the parent
    task.
  - `whyStopped`: the concrete blocker, and why the decision is not the
    agent's.
  - `whatWeNeed`: the question and the consequence of each option.
- **Where the recommendation goes.** In `recommendation`, not inside
  `whatWeNeed`.
- **What `relatedWork` is for.** Only links Paperclip cannot see. Parent,
  siblings, and blockers are shown automatically and must not be restated.
- **How to mention a task.** At first mention, write `CAT-61 (short title)`.
- **Task summaries.** When creating or delegating a task, set `summary`:
  what the task is for and the expected outcome, in up to 3 short paragraphs.
- **Examples.** The existing approval, standalone-decision, bundle, and
  checkbox examples gain a `brief`.

Also update:

- `skills/paperclip/references/api-reference.md`: `brief`, `summary`, and the
  context endpoint.
- `doc/SPEC-implementation.md`: an additive note on briefs, task summaries,
  and the context endpoint.
- `doc/DATABASE.md`: only if it enumerates columns of the affected tables.

## 8. Testing

Vitest (`pnpm test`):

- **shared**
  - `decisionBriefSchema`: limits, `version: 1`, `relatedWork` capped at 8.
  - `issues.summary` capped at 600.
  - `extractIssueIdentifiers`: dedupes, caps at 30, and ignores case ids.
- **server: create paths**
  - `brief` is persisted and returned for interactions, decisions (single and
    bundle), and approvals. A missing brief comes back as `null`.
  - A malformed brief returns 422.
  - With the flag on, human-facing items return 422 and agent-addressed
    interactions pass.
  - Toggling the flag writes an activity log entry.
- **server: `decision-context`**
  - Chain order, `requestedBy`, and the 10-level cap.
  - Siblings and totals.
  - `blockedBy`, `blocks`, and `downstreamCount` with the depth cap.
  - `relatedDecisions` across the root subtree, excluding self.
  - `recentActivity` excerpts and `referencedIssues` resolution.
  - A cross-company source returns 404, and an invalid kind returns 400.
  - A section failure produces `partial` and `failedSections`.
  - Query count stays fixed across tree sizes.
- **server: attention.** `hasBrief` and `briefExcerpt` for in-scope and
  out-of-scope kinds.
- **ui**
  - `DecisionContextPanel`: with a brief, without a brief, loading, partial
    and retry, `relationsDefaultOpen`, and the `relatedWork` merge.
  - `InlineReferenceText` linkifies plain-text fields.
  - `MarkdownIssueLink` `showTitle`.
  - The `IssueQuicklookCard` extended variant, including the summary
    fallback.
  - The collapsed row's excerpt and badge.
  - Updates to `DecisionCard.test.tsx`.

Browser (`pnpm test:e2e`, run for phase 3 only): expand a decision, see the
relations, hover a mention, and see the quicklook.

## 9. Delivery phases

Each phase is an independent PR following `.github/PULL_REQUEST_TEMPLATE.md`
and passes `pnpm -r typecheck`, `pnpm test:run` and `pnpm build`. Phase 3
also passes `pnpm check:token-gates`.

1. **Contracts and skill.** Migration, shared types and validators, write/read
   paths, enforcement validation, CLI `--summary`, skill, and docs. Briefs
   already render in markdown fields such as `detailsMarkdown` and `body`.
2. **Context endpoint.** The `decision-context` service and route, plus
   `hasBrief`/`briefExcerpt` in the feed.
3. **UI.** `DecisionContextPanel`, the collapsed row, `InlineReferenceText`,
   `showTitle`, the extended quicklook, and the task summary editor.
4. **Enforcement UI.** The company settings switch.

## 10. Risks

- **Generic or wrong briefs.** Relations computed alongside make
  inconsistencies visible.
- **Agents on an old skill.** Nothing breaks. They get the "no agent context"
  marker and computed relations.
- **Large trees.** Hard caps and bounded depth keep the endpoint's cost fixed.
- **Payload growth.** At most ~4 KB of brief per item, never added to the feed
  list.
