# Decision Context — Phase 1 (Contracts and Skill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and return an optional structured `brief` on issue-thread interactions, standalone decisions and approvals. Add an optional `summary` on tasks and a per-company `requireDecisionBrief` flag, and teach agents to write both through the `paperclip` skill.

**Architecture:** A shared `DecisionBrief` type and zod schema are added to the three create contracts and stored in a new `brief jsonb` column on each table. A single server guard, `decisionBriefGuard`, enforces the company flag for human-facing items and rejects `relatedWork` ids from other companies. `issues.summary` flows through the existing create/update spread and change-receipt paths. There is no UI in this phase beyond type updates.

**Tech Stack:** TypeScript, zod, Drizzle ORM (Postgres), Express, Vitest with embedded Postgres and supertest, commander (CLI).

**Spec:** `doc/plans/2026-09-27-decision-context.md` (sections 4 and 7; phase 1 of section 9).

## Global Constraints

- `DecisionBrief.version` is the literal `1`. The paragraphs `whatIsHappening`, `whyStopped` and `whatWeNeed` are each 1..1200 chars. `recommendation` is 1..400. `relatedWork` holds at most 8 entries, and each `note` is 1..300.
- `issues.summary` holds at most 600 chars and at most 3 paragraphs. An empty string is stored as `null`.
- A malformed `brief` or `summary` is a zod failure and returns **400**. An unknown or foreign `relatedWork` id returns **422**. A missing brief under the company flag returns **422** with exactly: `This company requires a decision brief for human-facing questions. Add brief.whatIsHappening, brief.whyStopped and brief.whatWeNeed.`
- These items are human-facing:
  - an interaction with `effectiveResolverPolicy === "human_only"` or a non-null `addresseeUserId`;
  - every standalone decision;
  - every approval.

  Everything else is exempt.
- `brief` does not take part in idempotency equivalence.
- `companies.requireDecisionBrief` defaults to `false`.
- Every change stays company-scoped (AGENTS.md §5.1). Contracts stay synced across db, shared, server and ui (§5.2).
- UI copy uses *task*, never *issue* (DESIGN.md principle 7). This phase adds no UI copy.
- Run `pnpm -r typecheck`, `pnpm test:run` and `pnpm build` before the PR. The PR body follows `.github/PULL_REQUEST_TEMPLATE.md`.

## Review Focus

- **A brief whose `relatedWork` names an issue id from another company.** The expected result is 422 and no row written. This must never silently link across companies. It is pinned in Task 4.
- **The flag is on and an idempotent retry of an already-created decision has no brief.** The existing decision must be returned without a 422, because the guard runs after the idempotency short-circuit. It is pinned in Task 6.
- **The flag is on and an interaction is addressed to an agent, or uses the default `anyone`.** It must still be created. It is pinned in Task 5.
- **A summary with whitespace only, or with escaped `\n\n` from a CLI.** Whitespace alone is stored as `null`, and escaped breaks count as paragraph breaks. This is pinned in Task 2.
- **Long `summary` edits in the activity log.** The receipt is truncated like `description` instead of storing 600 chars twice. This is pinned in Task 2.

---

### Task 0: Isolated workspace

The current checkout (`fix/ui-random-uuid-insecure-context`) has unrelated uncommitted work. Do not implement there.

- [ ] **Step 1: Create a worktree from `master`.** Use superpowers:using-git-worktrees with branch `feat/decision-context-phase-1`, based on `master`.
- [ ] **Step 2: Copy both plan docs into the worktree**

```bash
cp /home/sergio/workspaces/paperclip/doc/plans/2026-09-27-decision-context.md <worktree>/doc/plans/
cp /home/sergio/workspaces/paperclip/doc/plans/2026-09-27-decision-context-phase-1-plan.md <worktree>/doc/plans/
cd <worktree> && pnpm install
```

- [ ] **Step 3: Commit the docs**

```bash
git add doc/plans/2026-09-27-decision-context.md doc/plans/2026-09-27-decision-context-phase-1-plan.md
git commit -m "docs(plans): add decision context spec and phase 1 plan"
```

---

### Task 1: Shared `DecisionBrief` type and schema

**Files:**
- Create: `packages/shared/src/types/decision-brief.ts`
- Create: `packages/shared/src/validators/decision-brief.ts`
- Create: `packages/shared/src/validators/decision-brief.test.ts`
- Modify: `packages/shared/src/index.ts` (next to `export * from "./validators/status-card.js";`, ~line 343)

**Interfaces:**
- Produces: `interface DecisionBrief`, `interface DecisionBriefRelatedWork`, `DECISION_BRIEF_LIMITS`, `decisionBriefSchema` (output type assignable to `DecisionBrief`). Everything is exported from `@paperclipai/shared`.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/validators/decision-brief.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DECISION_BRIEF_LIMITS, decisionBriefSchema } from "./decision-brief.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const valid = {
  version: 1,
  whatIsHappening: "Integrating the payment gateway the CTO requested in CAT-50.",
  whyStopped: "Two providers fit and the choice changes cost and delivery date.",
  whatWeNeed: "Pick Stripe (ships this week) or Adyen (needs Finance contract first).",
};

describe("decisionBriefSchema", () => {
  it("accepts the three required paragraphs", () => {
    expect(decisionBriefSchema.parse(valid)).toEqual(valid);
  });

  it("accepts recommendation and relatedWork", () => {
    const parsed = decisionBriefSchema.parse({
      ...valid,
      recommendation: "Stripe — faster, and volume is below Adyen's tier.",
      relatedWork: [{ issueId, note: "Order emails wait on this." }],
    });
    expect(parsed.relatedWork).toEqual([{ issueId, note: "Order emails wait on this." }]);
  });

  it("trims and normalizes escaped line breaks", () => {
    const parsed = decisionBriefSchema.parse({ ...valid, whyStopped: "  First.\\n\\nSecond.  " });
    expect(parsed.whyStopped).toBe("First.\n\nSecond.");
  });

  it("rejects a missing paragraph", () => {
    const { whyStopped: _omit, ...rest } = valid;
    expect(decisionBriefSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects blank paragraphs", () => {
    expect(decisionBriefSchema.safeParse({ ...valid, whatWeNeed: "   " }).success).toBe(false);
  });

  it("rejects a version other than 1", () => {
    expect(decisionBriefSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
  });

  it("enforces paragraph and recommendation limits", () => {
    const tooLong = "x".repeat(DECISION_BRIEF_LIMITS.paragraph + 1);
    expect(decisionBriefSchema.safeParse({ ...valid, whatIsHappening: tooLong }).success).toBe(false);
    const longRec = "x".repeat(DECISION_BRIEF_LIMITS.recommendation + 1);
    expect(decisionBriefSchema.safeParse({ ...valid, recommendation: longRec }).success).toBe(false);
  });

  it("caps relatedWork at 8 entries and each note at 300 chars", () => {
    const nine = Array.from({ length: 9 }, () => ({ note: "n" }));
    expect(decisionBriefSchema.safeParse({ ...valid, relatedWork: nine }).success).toBe(false);
    const longNote = [{ note: "x".repeat(DECISION_BRIEF_LIMITS.relatedWorkNote + 1) }];
    expect(decisionBriefSchema.safeParse({ ...valid, relatedWork: longNote }).success).toBe(false);
  });

  it("rejects non-uuid ids and unknown keys", () => {
    expect(decisionBriefSchema.safeParse({ ...valid, relatedWork: [{ issueId: "CAT-61", note: "n" }] }).success).toBe(false);
    expect(decisionBriefSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/shared/src/validators/decision-brief.test.ts`
Expected: FAIL (`Cannot find module './decision-brief.js'`).

- [ ] **Step 3: Write the type**

`packages/shared/src/types/decision-brief.ts`:

```ts
/**
 * Agent-written narrative attached to a human-facing question, decision or
 * approval. Relations (parent, siblings, blockers) are computed by Paperclip
 * and must not be restated here; `relatedWork` is only for links the system
 * cannot see.
 */
export interface DecisionBriefRelatedWork {
  issueId?: string;
  agentId?: string;
  note: string;
}

export interface DecisionBrief {
  version: 1;
  whatIsHappening: string;
  whyStopped: string;
  whatWeNeed: string;
  recommendation?: string;
  relatedWork?: DecisionBriefRelatedWork[];
}
```

- [ ] **Step 4: Write the schema**

`packages/shared/src/validators/decision-brief.ts`:

```ts
import { z } from "zod";
import type { DecisionBrief } from "../types/decision-brief.js";
import { multilineTextSchema } from "./text.js";

export const DECISION_BRIEF_LIMITS = {
  paragraph: 1200,
  recommendation: 400,
  relatedWorkNote: 300,
  relatedWorkItems: 8,
} as const;

const briefText = (max: number) => multilineTextSchema.pipe(z.string().trim().min(1).max(max));

export const decisionBriefSchema = z
  .object({
    version: z.literal(1),
    whatIsHappening: briefText(DECISION_BRIEF_LIMITS.paragraph),
    whyStopped: briefText(DECISION_BRIEF_LIMITS.paragraph),
    whatWeNeed: briefText(DECISION_BRIEF_LIMITS.paragraph),
    recommendation: briefText(DECISION_BRIEF_LIMITS.recommendation).optional(),
    relatedWork: z
      .array(
        z
          .object({
            issueId: z.string().guid().optional(),
            agentId: z.string().guid().optional(),
            note: briefText(DECISION_BRIEF_LIMITS.relatedWorkNote),
          })
          .strict(),
      )
      .max(DECISION_BRIEF_LIMITS.relatedWorkItems)
      .optional(),
  })
  .strict();

// Compile-time guard: the parsed shape must stay assignable to the shared type.
const _decisionBriefShapeCheck: (value: z.infer<typeof decisionBriefSchema>) => DecisionBrief = (value) => value;
void _decisionBriefShapeCheck;
```

- [ ] **Step 5: Export from the package root**

In `packages/shared/src/index.ts`, directly after `export * from "./validators/status-card.js";`, add:

```ts
export * from "./types/decision-brief.js";
export * from "./validators/decision-brief.js";
```

- [ ] **Step 6: Run the test and typecheck**

Run: `pnpm vitest run packages/shared/src/validators/decision-brief.test.ts && pnpm --filter @paperclipai/shared typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/decision-brief.ts packages/shared/src/validators/decision-brief.ts packages/shared/src/validators/decision-brief.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add DecisionBrief type and validator"
```

---

### Task 2: Schema migration and task `summary` end to end

This task adds all five DB columns in one migration and wires `issues.summary` through the validators, the change receipt and the CLI. `summary` is the only new column with no guard dependency.

**Files:**
- Modify: `packages/db/src/schema/issue_thread_interactions.ts` (add a `brief` column after `summary`)
- Modify: `packages/db/src/schema/decisions.ts` (add a `brief` column to `decisions` after `body`)
- Modify: `packages/db/src/schema/approvals.ts` (add a `brief` column after `payload`)
- Modify: `packages/db/src/schema/issues.ts:41` (add `summary` after `description`)
- Modify: `packages/db/src/schema/companies.ts:18-20` (add `requireDecisionBrief` after `requireBoardApprovalForNewAgents`)
- Generated: `packages/db/src/migrations/0284_*.sql` and `meta/*`
- Modify: `packages/shared/src/validators/issue.ts` (near `createIssueBaseSchema`, line ~680)
- Modify: `packages/shared/src/types/issue.ts` (`Issue`, after `description` ~line 789)
- Modify: `server/src/services/issue-change-receipt.ts:34-38`
- Modify: `cli/src/commands/client/issue.ts` (options interfaces ~53/66, create ~282, update ~322)
- Test: `packages/shared/src/validators/issue-summary.test.ts` (create)
- Test: `server/src/__tests__/issue-change-receipt.test.ts` (create, or extend if it exists)

**Interfaces:**
- Produces:
  - DB columns `issueThreadInteractions.brief`, `decisions.brief`, `approvals.brief` (all `DecisionBrief | null`), `issues.summary` (`string | null`) and `companies.requireDecisionBrief` (`boolean`).
  - `ISSUE_SUMMARY_LIMITS = { maxLength: 600, maxParagraphs: 3 }`.
  - `issueSummarySchema` (output `string | null`).
  - `Issue.summary?: string | null`.

- [ ] **Step 1: Write the failing validator test**

`packages/shared/src/validators/issue-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createIssueSchema, ISSUE_SUMMARY_LIMITS, issueSummarySchema, updateIssueSchema } from "./issue.js";

describe("issue summary", () => {
  it("accepts up to three paragraphs", () => {
    expect(issueSummarySchema.parse("One.\n\nTwo.\n\nThree.")).toBe("One.\n\nTwo.\n\nThree.");
  });

  it("rejects a fourth paragraph", () => {
    expect(issueSummarySchema.safeParse("1\n\n2\n\n3\n\n4").success).toBe(false);
  });

  it("counts escaped CLI line breaks as paragraph breaks", () => {
    expect(issueSummarySchema.safeParse("1\\n\\n2\\n\\n3\\n\\n4").success).toBe(false);
  });

  it("rejects more than the max length", () => {
    expect(issueSummarySchema.safeParse("x".repeat(ISSUE_SUMMARY_LIMITS.maxLength + 1)).success).toBe(false);
  });

  it("stores whitespace-only as null", () => {
    expect(issueSummarySchema.parse("   \n  ")).toBeNull();
  });

  it("is optional on create and update", () => {
    expect(createIssueSchema.parse({ title: "T" }).summary).toBeUndefined();
    expect(createIssueSchema.parse({ title: "T", summary: "Why." }).summary).toBe("Why.");
    expect(updateIssueSchema.parse({ summary: null }).summary).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing change-receipt test**

First check whether `server/src/__tests__/issue-change-receipt.test.ts` exists (`ls server/src/__tests__ | grep change-receipt`). If it does, append the `it` below to its `describe`. If it doesn't, create the file:

```ts
import { describe, expect, it } from "vitest";
import { buildIssueChanges } from "../services/issue-change-receipt.js";

describe("buildIssueChanges summary", () => {
  it("truncates summary changes like description", () => {
    const from = "a".repeat(600);
    const to = "b".repeat(600);
    const changes = buildIssueChanges({ summary: from }, { summary: to });
    expect(changes.summary).toEqual({ from: "a".repeat(200), to: "b".repeat(200), updated: true });
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `pnpm vitest run packages/shared/src/validators/issue-summary.test.ts server/src/__tests__/issue-change-receipt.test.ts`
Expected: FAIL (`issueSummarySchema` is not exported, and `changes.summary` has no `updated`).

- [ ] **Step 4: Add the DB columns**

In `packages/db/src/schema/issue_thread_interactions.ts`, add `DecisionBrief` to the existing `import type { … } from "@paperclipai/shared"` list. After `summary: text("summary"),`, add:

```ts
    brief: jsonb("brief").$type<DecisionBrief>(),
```

In `packages/db/src/schema/decisions.ts`, change the first import to `import type { DecisionBrief, DecisionInput, DecisionOption } from "@paperclipai/shared";`. In the `decisions` table, after `body: text("body").notNull(),`, add:

```ts
    brief: jsonb("brief").$type<DecisionBrief>(),
```

In `packages/db/src/schema/approvals.ts`, add `import type { DecisionBrief } from "@paperclipai/shared";`. After the `payload` line, add:

```ts
    brief: jsonb("brief").$type<DecisionBrief>(),
```

In `packages/db/src/schema/issues.ts`, after `description: text("description"),`, add:

```ts
    summary: text("summary"),
```

In `packages/db/src/schema/companies.ts`, after the `requireBoardApprovalForNewAgents` block, add:

```ts
    requireDecisionBrief: boolean("require_decision_brief")
      .notNull()
      .default(false),
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/src/migrations/0284_<name>.sql` containing exactly five `ALTER TABLE … ADD COLUMN` statements:

- `"issue_thread_interactions" ADD COLUMN "brief" jsonb`
- `"decisions" ADD COLUMN "brief" jsonb`
- `"approvals" ADD COLUMN "brief" jsonb`
- `"issues" ADD COLUMN "summary" text`
- `"companies" ADD COLUMN "require_decision_brief" boolean DEFAULT false NOT NULL`

Open the file and confirm there are no unrelated statements. If there are any, stop and report them, because it means `master`'s schema and migrations had already drifted.

- [ ] **Step 6: Add the summary validator**

In `packages/shared/src/validators/issue.ts`, directly above `const createIssueBaseSchema = z.object({`, add:

```ts
export const ISSUE_SUMMARY_LIMITS = { maxLength: 600, maxParagraphs: 3 } as const;

export const issueSummarySchema = multilineTextSchema
  .pipe(
    z
      .string()
      .trim()
      .max(ISSUE_SUMMARY_LIMITS.maxLength)
      .refine(
        (value) => value.split(/\n\s*\n/).filter((paragraph) => paragraph.trim()).length <= ISSUE_SUMMARY_LIMITS.maxParagraphs,
        { message: `summary must have at most ${ISSUE_SUMMARY_LIMITS.maxParagraphs} paragraphs` },
      ),
  )
  .transform((value) => (value.length > 0 ? value : null));
```

Inside `createIssueBaseSchema`, directly after `description: multilineTextSchema.optional().nullable(),`, add:

```ts
  summary: issueSummarySchema.optional().nullable(),
```

(`createIssueSchema`, `createChildIssueSchema` and `updateIssueSchema` all derive from `createIssueBaseSchema`, so they pick it up. `issue.ts` is already re-exported by `validators/index.ts`. If that export list is explicit rather than `*`, add `ISSUE_SUMMARY_LIMITS` and `issueSummarySchema` next to `createIssueSchema` in the `} from "./issue.js";` block, around line 521.)

- [ ] **Step 7: Add `summary` to the `Issue` type**

In `packages/shared/src/types/issue.ts`, in `interface Issue`, directly after `description: string | null;`, add:

```ts
  /** Up to 3 short paragraphs: what the task is for and its expected outcome. */
  summary?: string | null;
```

- [ ] **Step 8: Truncate summary receipts**

In `server/src/services/issue-change-receipt.ts`, change:

```ts
    const longText =
      key === "description" ||
```

to:

```ts
    const longText =
      key === "description" ||
      key === "summary" ||
```

- [ ] **Step 9: Add CLI `--summary`**

In `cli/src/commands/client/issue.ts`:

- Add `summary?: string;` to both `IssueCreateOptions` (~line 53) and `IssueUpdateOptions` (~line 66), after `description?`.
- Add `.option("--summary <text>", "Short task summary (up to 3 paragraphs)")` after the `--description` option in both the `create` and `update` commands.
- Add `summary: opts.summary,` after `description: opts.description,` in both `createIssueSchema.parse({…})` and `updateIssueSchema.parse({…})`.

- [ ] **Step 10: Run the tests and typecheck**

Run: `pnpm vitest run packages/shared/src/validators/issue-summary.test.ts server/src/__tests__/issue-change-receipt.test.ts && pnpm -r typecheck`
Expected: PASS, and no type errors. The server's `issueService.create` and `update` spread `issueData`, and `hydrateInteraction` and `approvalService.create` spread rows and input, so no service code needs changing for the columns to round-trip.

- [ ] **Step 11: Commit**

```bash
git add packages/db packages/shared/src/validators/issue.ts packages/shared/src/validators/issue-summary.test.ts packages/shared/src/types/issue.ts server/src/services/issue-change-receipt.ts server/src/__tests__/issue-change-receipt.test.ts cli/src/commands/client/issue.ts
git commit -m "feat(db,shared): add decision brief columns, task summary and brief flag"
```

---

### Task 3: Company `requireDecisionBrief` flag in contracts

**Files:**
- Modify: `packages/shared/src/types/company.ts:29`
- Modify: `packages/shared/src/validators/company.ts:39`
- Modify: `server/src/services/companies.ts:152` (`companySelection`)
- Test: `server/src/__tests__/companies-service.test.ts` (append one `it`)

**Interfaces:**
- Produces:
  - `Company.requireDecisionBrief?: boolean`
  - `updateCompanySchema` accepts `requireDecisionBrief?: boolean`
  - `companyService(db).get*` returns it.

- [ ] **Step 1: Write the failing test**

Append the following inside `describeEmbeddedPostgres("companyService", …)` in `server/src/__tests__/companies-service.test.ts`. Reuse that file's existing seeding helper; read the lines around its first `companyService(db).update(` call, near line 378, and copy how that test obtains a `companyId`:

```ts
  it("persists and returns requireDecisionBrief", async () => {
    const companyId = await seedCompanyForBriefFlag();
    const updated = await companyService(db).update(companyId, { requireDecisionBrief: true });
    expect(updated?.requireDecisionBrief).toBe(true);
    const reread = await companyService(db).getById(companyId);
    expect(reread?.requireDecisionBrief).toBe(true);
  });
```

Define `seedCompanyForBriefFlag` next to the test, using the same insert pattern the file already uses:

```ts
  async function seedCompanyForBriefFlag() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Brief flag",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }
```

If `companyService` exposes its getter under a different name than `getById`, use that name. Check with `grep -n "getById\|get: async" server/src/services/companies.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run server/src/__tests__/companies-service.test.ts -t requireDecisionBrief`
Expected: FAIL (`requireDecisionBrief` is `undefined`).

- [ ] **Step 3: Implement**

`packages/shared/src/types/company.ts`, after `requireBoardApprovalForNewAgents: boolean;`:

```ts
  /** When true, human-facing questions, decisions and approvals must carry a brief. */
  requireDecisionBrief?: boolean;
```

`packages/shared/src/validators/company.ts`, after `requireBoardApprovalForNewAgents: z.boolean().optional(),`:

```ts
      requireDecisionBrief: z.boolean().optional(),
```

`server/src/services/companies.ts`, in `companySelection`, after the `requireBoardApprovalForNewAgents` line:

```ts
    requireDecisionBrief: companies.requireDecisionBrief,
```

(The `PATCH /companies/:companyId` route already parses `updateCompanySchema` and logs `company.updated`, so no route change is needed.)

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run server/src/__tests__/companies-service.test.ts -t requireDecisionBrief`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/company.ts packages/shared/src/validators/company.ts server/src/services/companies.ts server/src/__tests__/companies-service.test.ts
git commit -m "feat(companies): expose requireDecisionBrief setting"
```

---

### Task 4: `decisionBriefGuard` server module

**Files:**
- Create: `server/src/services/decision-brief.ts`
- Modify: `server/src/services/index.ts` (export it next to `decisionService`, ~line 79)
- Test: `server/src/__tests__/decision-brief-guard.test.ts` (create)

**Interfaces:**
- Consumes: `DecisionBrief` (Task 1) and `companies.requireDecisionBrief` (Task 2).
- Produces:
  - `DECISION_BRIEF_REQUIRED_MESSAGE: string`
  - `decisionBriefGuard(db: Db): { assertAllowed(input: { companyId: string; brief: DecisionBrief | null | undefined; humanFacing: boolean }): Promise<void> }`, which throws `unprocessable` (422).

- [ ] **Step 1: Write the failing test**

`server/src/__tests__/decision-brief-guard.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import type { DecisionBrief } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { DECISION_BRIEF_REQUIRED_MESSAGE, decisionBriefGuard } from "../services/decision-brief.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

const brief = (extra: Partial<DecisionBrief> = {}): DecisionBrief => ({
  version: 1,
  whatIsHappening: "Doing X for the CTO.",
  whyStopped: "Two valid options.",
  whatWeNeed: "Pick one.",
  ...extra,
});

describePg("decisionBriefGuard", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-brief-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(issues); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => tempDb?.cleanup());

  async function seedCompany(requireDecisionBrief = false) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Brief", issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireDecisionBrief,
    });
    return companyId;
  }
  async function seedIssue(companyId: string) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: "T", status: "todo", priority: "medium" });
    return id;
  }
  async function seedAgent(companyId: string) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name: "A", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    return id;
  }

  it("allows a missing brief when the flag is off", async () => {
    const companyId = await seedCompany(false);
    await expect(decisionBriefGuard(db).assertAllowed({ companyId, brief: null, humanFacing: true })).resolves.toBeUndefined();
  });

  it("rejects a missing brief for human-facing items when the flag is on", async () => {
    const companyId = await seedCompany(true);
    await expect(decisionBriefGuard(db).assertAllowed({ companyId, brief: undefined, humanFacing: true }))
      .rejects.toMatchObject({ status: 422, message: DECISION_BRIEF_REQUIRED_MESSAGE });
  });

  it("allows a missing brief for agent-facing items when the flag is on", async () => {
    const companyId = await seedCompany(true);
    await expect(decisionBriefGuard(db).assertAllowed({ companyId, brief: null, humanFacing: false })).resolves.toBeUndefined();
  });

  it("accepts relatedWork ids from the same company", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const agentId = await seedAgent(companyId);
    await expect(decisionBriefGuard(db).assertAllowed({
      companyId, humanFacing: true, brief: brief({ relatedWork: [{ issueId, agentId, note: "n" }] }),
    })).resolves.toBeUndefined();
  });

  it("rejects relatedWork issue ids from another company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const foreignIssueId = await seedIssue(otherCompanyId);
    await expect(decisionBriefGuard(db).assertAllowed({
      companyId, humanFacing: true, brief: brief({ relatedWork: [{ issueId: foreignIssueId, note: "n" }] }),
    })).rejects.toMatchObject({ status: 422 });
  });

  it("rejects unknown relatedWork agent ids", async () => {
    const companyId = await seedCompany();
    await expect(decisionBriefGuard(db).assertAllowed({
      companyId, humanFacing: true, brief: brief({ relatedWork: [{ agentId: randomUUID(), note: "n" }] }),
    })).rejects.toMatchObject({ status: 422 });
  });
});
```

Before running, confirm the `HttpError` shape: `grep -n "class HttpError" -A8 server/src/errors.ts`. If the status property is not named `status`, adjust `toMatchObject` to the real property name.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run server/src/__tests__/decision-brief-guard.test.ts`
Expected: FAIL (`Cannot find module '../services/decision-brief.js'`).

- [ ] **Step 3: Implement**

`server/src/services/decision-brief.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";
import { agents, companies, issues, type Db } from "@paperclipai/db";
import type { DecisionBrief } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export const DECISION_BRIEF_REQUIRED_MESSAGE =
  "This company requires a decision brief for human-facing questions. Add brief.whatIsHappening, brief.whyStopped and brief.whatWeNeed.";

function uniqueIds(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/**
 * Enforces the company's decision-brief policy and keeps `relatedWork`
 * references inside the company boundary. Call it after any idempotency
 * short-circuit so retries of existing records are never rejected.
 */
export function decisionBriefGuard(db: Db) {
  return {
    assertAllowed: async (input: {
      companyId: string;
      brief: DecisionBrief | null | undefined;
      humanFacing: boolean;
    }) => {
      const { companyId, brief, humanFacing } = input;
      if (!brief) {
        if (!humanFacing) return;
        const required = await db
          .select({ required: companies.requireDecisionBrief })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => rows[0]?.required ?? false);
        if (required) throw unprocessable(DECISION_BRIEF_REQUIRED_MESSAGE);
        return;
      }

      const issueIds = uniqueIds((brief.relatedWork ?? []).map((entry) => entry.issueId));
      if (issueIds.length) {
        const found = await db
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
        if (found.length !== issueIds.length) {
          throw unprocessable("brief.relatedWork references a task outside this company");
        }
      }

      const agentIds = uniqueIds((brief.relatedWork ?? []).map((entry) => entry.agentId));
      if (agentIds.length) {
        const found = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
        if (found.length !== agentIds.length) {
          throw unprocessable("brief.relatedWork references an agent outside this company");
        }
      }
    },
  };
}
```

In `server/src/services/index.ts`, after `export { decisionService } from "./decisions.js";`, add:

```ts
export { decisionBriefGuard, DECISION_BRIEF_REQUIRED_MESSAGE } from "./decision-brief.js";
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run server/src/__tests__/decision-brief-guard.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/decision-brief.ts server/src/services/index.ts server/src/__tests__/decision-brief-guard.test.ts
git commit -m "feat(server): add decision brief guard"
```

---

### Task 5: Brief on issue-thread interactions

**Files:**
- Modify: `packages/shared/src/validators/issue.ts:1865-1869` (`createIssueThreadInteractionCommon`)
- Modify: `packages/shared/src/types/issue.ts` (`IssueThreadInteractionBase`, after `summary?` ~line 1499)
- Modify: `server/src/services/issue-thread-interactions.ts` (`create`, ~lines 3315-3530)
- Test: `server/src/__tests__/issue-thread-interactions-service.test.ts` (append tests)

**Interfaces:**
- Consumes: `decisionBriefSchema` (Task 1) and `decisionBriefGuard` (Task 4).
- Produces: `CreateIssueThreadInteraction` accepts `brief?: DecisionBrief | null`, and `IssueThreadInteraction.brief?: DecisionBrief | null` is returned by `create`, `list` and `get`.

- [ ] **Step 1: Write the failing tests**

Append inside `describeEmbeddedPostgres("issueThreadInteractionService", …)`:

```ts
  const confirmationInput = (extra: Record<string, unknown> = {}) => ({
    kind: "request_confirmation" as const,
    title: "Choose provider",
    payload: { version: 1 as const, prompt: "Proceed with Stripe?" },
    ...extra,
  });
  const sampleBrief = {
    version: 1 as const,
    whatIsHappening: "Integrating payments for the CTO.",
    whyStopped: "Provider choice changes cost.",
    whatWeNeed: "Confirm Stripe.",
  };

  it("persists and returns the interaction brief", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Brief round-trip");
    const created = await interactionsSvc.create({ id: issueId, companyId }, confirmationInput({ brief: sampleBrief }), { userId: "board-user" });
    expect(created.brief).toEqual(sampleBrief);
    const [listed] = await interactionsSvc.listForIssue(issueId);
    expect(listed.brief).toEqual(sampleBrief);
  });

  it("returns a null brief when omitted", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Brief omitted");
    const created = await interactionsSvc.create({ id: issueId, companyId }, confirmationInput(), { userId: "board-user" });
    expect(created.brief ?? null).toBeNull();
  });

  it("requires a brief for human_only interactions when the company flag is on", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Brief required");
    await db.update(companies).set({ requireDecisionBrief: true }).where(eq(companies.id, companyId));
    await expect(interactionsSvc.create(
      { id: issueId, companyId }, confirmationInput({ resolverPolicy: "human_only" }), { userId: "board-user" },
    )).rejects.toMatchObject({ status: 422 });
  });

  it("does not require a brief for default-audience interactions when the flag is on", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Brief exempt");
    await db.update(companies).set({ requireDecisionBrief: true }).where(eq(companies.id, companyId));
    const created = await interactionsSvc.create({ id: issueId, companyId }, confirmationInput(), { userId: "board-user" });
    expect(created.status).toBe("pending");
  });

  it("rejects a brief with a foreign relatedWork issue", async () => {
    const { companyId, issueId } = await seedConfirmationIssue("Brief foreign");
    const other = await seedConfirmationIssue("Other company");
    await expect(interactionsSvc.create(
      { id: issueId, companyId },
      confirmationInput({ brief: { ...sampleBrief, relatedWork: [{ issueId: other.issueId, note: "n" }] } }),
      { userId: "board-user" },
    )).rejects.toMatchObject({ status: 422 });
  });
```

Before running, check two names in the service and fix the test if they differ. Find the listing method with `grep -nE "^\s+list[A-Za-z]*: async" server/src/services/issue-thread-interactions.ts`, and replace `listForIssue` with the real name. Find the actor shape for a board user with `grep -n "type InteractionActor" -A6 server/src/services/issue-thread-interactions.ts`, and match `{ userId: "board-user" }` to it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run server/src/__tests__/issue-thread-interactions-service.test.ts -t brief`
Expected: FAIL. The brief is stripped by zod, so `created.brief` is undefined, and nothing throws 422.

- [ ] **Step 3: Accept `brief` in the create contract**

In `packages/shared/src/validators/issue.ts`, add `import { decisionBriefSchema } from "./decision-brief.js";` with the other imports at the top of the file. Then change `createIssueThreadInteractionCommon` to:

```ts
const createIssueThreadInteractionCommon = {
  resolverPolicy: issueThreadInteractionResolverPolicySchema.optional(),
  addresseeAgentId: z.string().guid().nullable().optional(),
  addresseeUserId: z.string().trim().min(1).nullable().optional(),
  brief: decisionBriefSchema.nullable().optional(),
};
```

- [ ] **Step 4: Expose `brief` on the read type**

In `packages/shared/src/types/issue.ts`, add `import type { DecisionBrief } from "./decision-brief.js";` at the top. In `IssueThreadInteractionBase`, directly after `summary?: string | null;`, add:

```ts
  brief?: DecisionBrief | null;
```

- [ ] **Step 5: Enforce and persist in the service**

In `server/src/services/issue-thread-interactions.ts`, add `import { decisionBriefGuard } from "./decision-brief.js";` next to the other `./` imports.

In `create`, find the block that throws `"An issue-thread interaction cannot address both an agent and a user"`. Directly after it, add:

```ts
      await decisionBriefGuard(db).assertAllowed({
        companyId: issue.companyId,
        brief: normalizedData.brief ?? null,
        humanFacing:
          policy.effectiveResolverPolicy === "human_only" ||
          Boolean(normalizedData.addresseeUserId),
      });
```

In the `.insert(issueThreadInteractions).values({ … })` call (~line 3498), directly after `summary: data.summary ?? null,`, add:

```ts
              brief: data.brief ?? null,
```

(`hydrateInteraction` spreads `row`, so the column is returned without further changes. If `normalizeCreateInteractionInput` builds a new object rather than spreading, confirm with `grep -n "function normalizeCreateInteractionInput" -A20` that `brief` survives, and add `brief: input.brief` there if it doesn't.)

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run server/src/__tests__/issue-thread-interactions-service.test.ts`
Expected: PASS for the whole file, including the existing tests.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/validators/issue.ts packages/shared/src/types/issue.ts server/src/services/issue-thread-interactions.ts server/src/__tests__/issue-thread-interactions-service.test.ts
git commit -m "feat(interactions): accept and enforce decision briefs"
```

---

### Task 6: Brief on standalone decisions and bundles

**Files:**
- Modify: `server/src/routes/decisions.ts:22-32` (`createSchema`)
- Modify: `server/src/services/decisions.ts:123-125` (`CreateInput`), `createInStore` (~line 191-230)
- Modify: `ui/src/api/decisions.ts:28-53` (`Decision`)
- Test: `server/src/__tests__/decisions-service.test.ts` (append tests)

**Interfaces:**
- Consumes: `decisionBriefSchema` and `DecisionBrief` (Task 1), and `decisionBriefGuard` (Task 4).
- Produces:
  - `POST /companies/:companyId/decisions` and `POST /companies/:companyId/decision-bundles` accept `brief` (at the top level of each decision).
  - The decision rows returned by `create`, `get`, `outcome` and `list` include `brief`.
  - The UI type `Decision.brief?: DecisionBrief | null`.

- [ ] **Step 1: Write the failing tests**

Append inside `describePg("decisionService", …)`, reusing the file's existing `createCommentDecision`, `service`, `agentActor`, `companyId`, `agentId`, `runId`:

```ts
  const decisionBrief = {
    version: 1 as const,
    whatIsHappening: "Cleaning up the launch tree the CTO opened.",
    whyStopped: "Reassigning changes ownership.",
    whatWeNeed: "Confirm the comment.",
  };

  it("persists and returns a decision brief", async () => {
    const created = await createCommentDecision("lenient", { brief: decisionBrief });
    expect(created.brief).toEqual(decisionBrief);
    const outcome = await service().outcome(created.id);
    expect(outcome.brief).toEqual(decisionBrief);
  });

  it("persists briefs on bundled decisions", async () => {
    const bundle = await service().createBundle({
      companyId, actor: agentActor(), agentId, runId, title: "Bundle", summary: "S",
      decisions: [{ title: "One?", body: "B", brief: decisionBrief,
        options: [{ id: "yes", label: "Yes", effects: [{ type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "hi" }] }] }],
    });
    expect(bundle.decisions[0].brief).toEqual(decisionBrief);
  });

  it("requires a brief when the company flag is on", async () => {
    await db.update(companies).set({ requireDecisionBrief: true }).where(eq(companies.id, companyId));
    await expect(createCommentDecision()).rejects.toMatchObject({ status: 422 });
  });

  it("returns an existing idempotent decision without re-checking the brief flag", async () => {
    const first = await createCommentDecision("lenient", { idempotencyKey: "brief-retry" });
    await db.update(companies).set({ requireDecisionBrief: true }).where(eq(companies.id, companyId));
    const retry = await createCommentDecision("lenient", { idempotencyKey: "brief-retry" });
    expect(retry.id).toBe(first.id);
  });
```

If `service().outcome` is not exposed on the service's return object, use the exported getter the route uses. `GET /decisions/:id` calls `svc.outcome`, so it is exposed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run server/src/__tests__/decisions-service.test.ts -t brief`
Expected: FAIL. TypeScript may also reject `brief` on `CreateInput`, since Vitest type-strips and does not typecheck; runtime assertions fail either way.

- [ ] **Step 3: Accept `brief` in the route schema**

In `server/src/routes/decisions.ts`, add `decisionBriefSchema` to the `@paperclipai/shared` import list. In `createSchema`, after `body: z.string().max(100_000),`, add:

```ts
  brief: decisionBriefSchema.nullable().optional(),
```

(`bundleSchema` reuses `createSchema`, so bundles pick it up.)

- [ ] **Step 4: Persist and enforce in the service**

In `server/src/services/decisions.ts`:

- Add `DecisionBrief` to the existing `@paperclipai/shared` type import.
- Add `import { decisionBriefGuard } from "./decision-brief.js";`.
- In `type CreateInput = { … }`, after `body: string;`, add `brief?: DecisionBrief | null;`.

In `createInStore`, find:

```ts
    const open = await dbOrTx.select({ value: count() }).from(decisions)
```

Directly **above** it (after both idempotency short-circuits have returned), add:

```ts
    await decisionBriefGuard(dbOrTx).assertAllowed({
      companyId: input.companyId,
      brief: input.brief ?? null,
      humanFacing: true,
    });
```

In the `insert(decisions).values({ … })` object, after `title: input.title, body: input.body,`, add:

```ts
      brief: input.brief ?? null,
```

Do not add `brief` to either `equivalent` comparison.

- [ ] **Step 5: Update the UI type**

In `ui/src/api/decisions.ts`, add `DecisionBrief` to the `@paperclipai/shared` type import (create the import if the file has none). In `interface Decision`, after `body: string;`, add:

```ts
  brief?: DecisionBrief | null;
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm vitest run server/src/__tests__/decisions-service.test.ts && pnpm --filter @paperclipai/server typecheck && pnpm --filter @paperclipai/ui typecheck`
Expected: PASS, and no type errors. If the UI package's filter name differs, check `ui/package.json` `name`.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/decisions.ts server/src/services/decisions.ts ui/src/api/decisions.ts server/src/__tests__/decisions-service.test.ts
git commit -m "feat(decisions): accept and enforce decision briefs"
```

---

### Task 7: Brief on approvals

**Files:**
- Modify: `packages/shared/src/validators/approval.ts:5-10`
- Modify: `packages/shared/src/types/approval.ts:3-16`
- Modify: `server/src/routes/approvals.ts:13-20` (import) and `:232` (create handler)
- Test: `server/src/__tests__/approval-routes-idempotency.test.ts` (extend the mocks and add tests)
- Test: `packages/shared/src/validators/approval.test.ts` (append)

**Interfaces:**
- Consumes: `decisionBriefSchema` and `DecisionBrief` (Task 1), and `decisionBriefGuard` exported from `server/src/services/index.ts` (Task 4).
- Produces: `CreateApproval.brief?: DecisionBrief | null`, `Approval.brief?: DecisionBrief | null`, and the route persists the brief and enforces the flag with `humanFacing: true`.

- [ ] **Step 1: Write the failing validator test**

Append to `packages/shared/src/validators/approval.test.ts`, inside its top-level `describe` (add `createApprovalSchema` to that file's import if it is missing):

```ts
  it("accepts an optional decision brief", () => {
    const brief = { version: 1, whatIsHappening: "a", whyStopped: "b", whatWeNeed: "c" };
    expect(createApprovalSchema.parse({ type: "request_board_approval", payload: {}, brief }).brief).toEqual(brief);
    expect(createApprovalSchema.safeParse({ type: "request_board_approval", payload: {}, brief: { version: 1 } }).success).toBe(false);
  });
```

- [ ] **Step 2: Write the failing route tests**

In `server/src/__tests__/approval-routes-idempotency.test.ts`:

Add a hoisted mock next to the others:

```ts
const mockDecisionBriefGuard = vi.hoisted(() => ({ assertAllowed: vi.fn() }));
```

Add `decisionBriefGuard: () => mockDecisionBriefGuard,` to the object returned by `vi.doMock("../services/index.js", …)`.

In `beforeEach`, add:

```ts
    mockDecisionBriefGuard.assertAllowed.mockReset();
    mockDecisionBriefGuard.assertAllowed.mockResolvedValue(undefined);
```

Add tests to the `describe`:

```ts
  it("passes the brief to the guard and persists it on approval create", async () => {
    const brief = { version: 1, whatIsHappening: "a", whyStopped: "b", whatWeNeed: "c" };
    mockApprovalService.create.mockResolvedValue({
      id: "approval-b", companyId: "company-1", type: "request_board_approval", requestedByAgentId: "agent-1",
      requestedByUserId: null, status: "pending", payload: { title: "Spend" }, brief, decisionNote: null,
      decidedByUserId: null, decidedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: { title: "Spend" }, brief });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockDecisionBriefGuard.assertAllowed).toHaveBeenCalledWith({ companyId: "company-1", brief, humanFacing: true });
    expect(mockApprovalService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ brief }));
  });

  it("returns 422 and does not create when the guard rejects", async () => {
    const { unprocessable } = await import("../errors.js");
    mockDecisionBriefGuard.assertAllowed.mockRejectedValue(unprocessable("This company requires a decision brief for human-facing questions. Add brief.whatIsHappening, brief.whyStopped and brief.whatWeNeed."));
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({ type: "request_board_approval", payload: { title: "Spend" } });
    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/shared/src/validators/approval.test.ts server/src/__tests__/approval-routes-idempotency.test.ts`
Expected: FAIL. The validator strips `brief`, and the route never calls the guard.

- [ ] **Step 4: Implement the shared contract**

`packages/shared/src/validators/approval.ts`: add `import { decisionBriefSchema } from "./decision-brief.js";`. In `createApprovalSchema`, after `issueIds`, add:

```ts
  brief: decisionBriefSchema.nullable().optional(),
```

`packages/shared/src/types/approval.ts`: add `import type { DecisionBrief } from "./decision-brief.js";`. In `interface Approval`, after `payload`, add:

```ts
  brief?: DecisionBrief | null;
```

- [ ] **Step 5: Enforce in the route**

In `server/src/routes/approvals.ts`, add `decisionBriefGuard,` to the `from "../services/index.js"` import list. In the `POST /companies/:companyId/approvals` handler, directly after `const { issueIds: _issueIds, ...approvalInput } = req.body;`, add:

```ts
    await decisionBriefGuard(db).assertAllowed({
      companyId,
      brief: approvalInput.brief ?? null,
      humanFacing: true,
    });
```

(`approvalInput` is spread into `svc.create`, and `approvalService.create` spreads it into the insert, so the column is written with no further change. The route's `db` parameter is the one passed to `approvalRoutes(db, …)`. Confirm the variable name at the top of the router factory.)

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/shared/src/validators/approval.test.ts server/src/__tests__/approval-routes-idempotency.test.ts`
Expected: PASS for the whole files.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/validators/approval.ts packages/shared/src/types/approval.ts server/src/routes/approvals.ts server/src/__tests__/approval-routes-idempotency.test.ts packages/shared/src/validators/approval.test.ts
git commit -m "feat(approvals): accept and enforce decision briefs"
```

---

### Task 8: Agent skill and docs

**Files:**
- Modify: `skills/paperclip/SKILL.md`. Add a new subsection after the interaction-kinds table and "Key shared semantics" list (before `### Standalone Decisions`), and update the JSON examples under "Requesting Board Approval", "Standalone Decisions", the bundle example and the checkbox example.
- Modify: `skills/paperclip/references/api-reference.md` (Issue response schemas and Governance and Approvals)
- Modify: `doc/SPEC-implementation.md` (additive note)
- Modify: `doc/DATABASE.md` (short note next to the decisions desk paragraph, ~line 237)

There is no automated test in this task. Its verification is a review read plus the repo checks in Task 9.

- [ ] **Step 1: Add the "Decision briefs" subsection to `SKILL.md`**

Insert exactly:

````markdown
### Decision Briefs

Humans answering your questions do not see your run. Give them the context in a `brief`:

```json
"brief": {
  "version": 1,
  "whatIsHappening": "I'm integrating the payment gateway the CTO requested in CAT-50 (Checkout v2). Cart and order flow (CAT-58) are done.",
  "whyStopped": "Stripe and Adyen both meet the requirements. The choice changes monthly cost (~$120 vs ~$300) and the delivery date.",
  "whatWeNeed": "Pick a provider. With Stripe I continue today; with Adyen I need Finance's contract details first.",
  "recommendation": "Stripe — faster, and our volume is below Adyen's pricing tier."
}
```

- **When:** on every interaction a human may answer (default `anyone`, `human_only`, or `addresseeUserId`), every standalone decision, and every approval. Optional when you address another agent with `addresseeAgentId`. A company may require it; a missing brief then fails with 422.
- **whatIsHappening:** the work in progress, who requested it, and the parent task.
- **whyStopped:** the concrete fact that blocked you and why the decision is not yours to make.
- **whatWeNeed:** the question and the consequence of each option. Put your pick in `recommendation`, not here.
- **relatedWork** (optional, max 8): only links Paperclip cannot see, e.g. `{ "note": "Finance promised the Adyen contract by email yesterday." }`. Parent, sibling and blocker tasks are shown automatically — do not restate them. `issueId`/`agentId` must be ids in this company.
- **Mentions:** the first time you mention a task, write its title: `CAT-61 (Integrate gateway)`.
- Limits: each paragraph ≤ 1200 chars, `recommendation` ≤ 400, each `relatedWork.note` ≤ 300.

When you create or delegate a task, set `summary`: what the task is for and its expected outcome, in up to 3 short paragraphs (≤ 600 chars). It is shown whenever the task is mentioned.
````

- [ ] **Step 2: Add `brief` to the existing examples**

- In `## Requesting Board Approval`, add a top-level `"brief": { … }` (sibling of `"payload"`) to the JSON example, with approval-appropriate text.
- In `### Standalone Decisions`, add `"brief"` after `"body"` in the single-decision example and in both decisions of the bundle example.
- In the `request_checkbox_confirmation` example, add a top-level `"brief"` after `"summary"`.

Every added brief must use `"version": 1` and all three required paragraphs.

- [ ] **Step 3: Update `references/api-reference.md`**

- Under `### Issue with Ancestors`, add `"summary": "…"` to the example issue JSON after `description`, and add a one-line note: "`summary` (≤ 600 chars, ≤ 3 paragraphs) is optional on create and update."
- Under `## Governance and Approvals`, add a paragraph: "Approvals, standalone decisions and issue-thread interactions accept an optional top-level `brief` (see SKILL.md → Decision Briefs). A malformed brief returns 400; a `relatedWork` id outside the company, or a missing brief when the company sets `requireDecisionBrief`, returns 422."

- [ ] **Step 4: Update `doc/SPEC-implementation.md` (additive)**

Find the section describing issue-thread interactions (`grep -n "interaction" doc/SPEC-implementation.md`, around lines 270-280). After the last bullet there, append:

```markdown
- Human-facing issue-thread interactions, standalone decisions, and board approvals accept an optional structured `brief` (`version: 1`; `whatIsHappening`, `whyStopped`, `whatWeNeed`, optional `recommendation` and `relatedWork`). When a company sets `requireDecisionBrief`, creating one without a brief returns 422 for interactions that are `human_only` or user-addressed, every standalone decision, and every approval. `relatedWork` ids must belong to the same company. Tasks carry an optional `summary` (≤ 600 chars, ≤ 3 paragraphs) shown wherever the task is referenced. See `doc/plans/2026-09-27-decision-context.md`.
```

- [ ] **Step 5: Update `doc/DATABASE.md`**

After the paragraph that begins "The decisions desk stores queue membership…", add:

```markdown
`issue_thread_interactions.brief`, `decisions.brief`, and `approvals.brief` hold the optional agent-written decision brief (JSON, `version: 1`). `issues.summary` is an optional short task summary. `companies.require_decision_brief` makes the brief mandatory for human-facing items.
```

- [ ] **Step 6: Commit**

```bash
git add skills/paperclip/SKILL.md skills/paperclip/references/api-reference.md doc/SPEC-implementation.md doc/DATABASE.md
git commit -m "docs(skill): teach agents to write decision briefs and task summaries"
```

---

### Task 9: Full verification and PR

- [ ] **Step 1: Run the repo checks**

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: all three succeed. If any fixture fails typecheck because a new optional field was made required by mistake, fix the type rather than the fixture. All new read fields are optional by design, to avoid fixture churn.

- [ ] **Step 2: Smoke-test against the dev server**

```bash
rm -rf data/pglite && pnpm dev
```

In another shell, create a company and task through the UI or API, then check that the round-trip works:

```bash
curl -s -X PATCH http://localhost:3100/api/issues/<issueId> -H 'content-type: application/json' \
  -d '{"summary":"Why this task exists.\n\nExpected outcome."}' | jq '.summary'
```

Expected: the summary string is returned.

- [ ] **Step 3: Open the PR**

Push `feat/decision-context-phase-1` and open a PR against `master`. The body must follow every section of `.github/PULL_REQUEST_TEMPLATE.md`:

- **Thinking Path**
- **What Changed**
- **Verification**: list the commands from Step 1 and the test files added.
- **Risks**: the migration adds nullable columns only, and old agents are unaffected.
- **Model Used**
- **Checklist**

End the body with the session attribution line.
