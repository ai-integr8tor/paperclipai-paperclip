import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// TES-278: a routine whose prior execution issue is `done` re-dispatches forever.
// `findLiveExecutionIssue` only coalesces into OPEN_ISSUE_STATUSES, so a completed
// issue is invisible to the mechanism permanently. The dispatch fingerprint already
// identifies "the same work" and is used only as a race guard.
describeEmbeddedPostgres("routine completed-issue suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-repeat-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.stop?.();
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seed(opts?: { repeatPolicy?: "always" | "skip_if_completed" | null; repeatWindowSeconds?: number | null }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Repeat Co",
      // The default prefix is PAP, so a second seeded company in one test collides.
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Repeater",
      responsibleUserId: randomUUID(),
    });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "P", status: "in_progress" });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, opts) => {
          const runId = randomUUID();
          const issueId =
            (typeof opts?.payload?.issueId === "string" && opts.payload.issueId) ||
            (typeof opts?.contextSnapshot?.issueId === "string" && opts.contextSnapshot.issueId) ||
            null;
          await db.insert(heartbeatRuns).values({
            id: runId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: opts?.source ?? "assignment",
            status: "queued",
            contextSnapshot: { ...(opts?.contextSnapshot ?? {}), ...(issueId ? { issueId } : {}) },
          });
          // The coalescing path requires the issue to be bound to a LIVE run.
          if (issueId) {
            await db
              .update(issues)
              .set({ executionRunId: runId, executionLockedAt: new Date() })
              .where(eq(issues.id, issueId));
          }
          return { id: runId };
        },
      },
    });

    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "permanent truth",
        description: "verify a condition that never becomes false",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        ...(opts?.repeatPolicy !== undefined ? { repeatPolicy: opts.repeatPolicy } : {}),
        ...(opts?.repeatWindowSeconds !== undefined ? { repeatWindowSeconds: opts.repeatWindowSeconds } : {}),
      } as never,
      {},
    );

    // A cron trigger is what makes tickScheduledTriggers fire the routine at all.
    await svc.createTrigger(
      routine.id,
      { kind: "schedule", label: "schedule", cronExpression: "0 * * * *", timezone: "UTC" } as never,
      {},
    );

    return { companyId, agentId, projectId, routine, svc };
  }

  async function executionIssues(companyId: string, routineId: string) {
    return db
      .select({ id: issues.id, status: issues.status, fingerprint: issues.originFingerprint, title: issues.title })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "routine_execution"), eq(issues.originId, routineId)))
      .orderBy(issues.createdAt);
  }

  /** Drive one scheduler tick by pointing the trigger's nextRunAt into the past. */
  async function tick(fx: Awaited<ReturnType<typeof seed>>) {
    await db
      .update(routineTriggers)
      .set({ nextRunAt: new Date(Date.now() - 1_000) })
      .where(eq(routineTriggers.routineId, fx.routine.id));
    return fx.svc.tickScheduledTriggers(new Date());
  }

  async function markAllExecutionIssuesDone(fx: Awaited<ReturnType<typeof seed>>, completedAt: Date) {
    await db
      .update(issues)
      .set({ status: "done", completedAt })
      .where(
        and(
          eq(issues.companyId, fx.companyId),
          eq(issues.originKind, "routine_execution"),
          eq(issues.originId, fx.routine.id),
        ),
      );
  }

  // ---- case 1: the board bug, reproduced ----
  it("does not re-dispatch when the prior execution issue is done inside the window", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(1);

    await markAllExecutionIssuesDone(fx, new Date());
    await tick(fx);

    const found = await executionIssues(fx.companyId, fx.routine.id);
    expect(found.length).toBe(1); // no new issue
    const last = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, fx.routine.id))
      .orderBy(desc(routineRuns.createdAt))
      .limit(1)
      .then((r) => r[0]!);
    // case 20: the suppression must be visible, not silent
    expect(last.status).toBe("skipped");
    // It links the satisfying issue and coalesces into the run that produced it —
    // the same shape as the open-issue coalescing path. coalescedIntoRunId is a
    // RUN id everywhere else, so pinning it stops an issue id creeping in here.
    expect(last.linkedIssueId).toBe(found[0]!.id);
    const originRunId = await db
      .select({ originRunId: issues.originRunId })
      .from(issues)
      .where(eq(issues.id, found[0]!.id))
      .then((r) => r[0]!.originRunId);
    expect(originRunId).not.toBeNull();
    expect(last.coalescedIntoRunId).toBe(originRunId);
  });

  // ---- case 11: the backwards-compat case, the one most likely to be wrong ----
  it("leaves behaviour unchanged when no repeat policy is set", async () => {
    const fx = await seed();
    await tick(fx);
    await markAllExecutionIssuesDone(fx, new Date());
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(2);
  });

  // ---- case 12: always_enqueue must not be suppressed ----
  it("does not suppress an always_enqueue routine", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    await db.update(routines).set({ concurrencyPolicy: "always_enqueue" }).where(eq(routines.id, fx.routine.id));
    await tick(fx);
    await markAllExecutionIssuesDone(fx, new Date());
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(2);
  });

  // ---- case 8: the dangerous bug. Different fingerprint = different work. ----
  it("still dispatches when the prior issue carried a different dispatch fingerprint", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    await tick(fx);
    await markAllExecutionIssuesDone(fx, new Date());
    // edit the description: the fingerprint is derived from it, so the work differs
    // Editing the description changes the routine body, so the fingerprint changes:
    // this is genuinely new work and must not be suppressed.
    await fx.svc.update(fx.routine.id, { description: "different work now" }, {});
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(2);
  });

  // ---- case 5: outside the window ----
  it("dispatches again once the completed issue falls outside the window", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 60 });
    await tick(fx);
    await markAllExecutionIssuesDone(fx, new Date(Date.now() - 61_000));
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(2);
  });

  // ---- case 6: window 0 must mean "off", not "never fire" ----
  it("treats a zero window as opt-out", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 0 });
    await tick(fx);
    await markAllExecutionIssuesDone(fx, new Date());
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(2);
  });

  // ---- case 2: a cancelled run did the same work ----
  it("treats a cancelled execution issue as completed", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    await tick(fx);
    await db
      .update(issues)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(issues.originId, fx.routine.id));
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(1);
  });

  // ---- case 3: an open issue must still coalesce, not be suppressed ----
  it("coalesces into an open issue rather than suppressing", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    await tick(fx);
    // issue is still `todo` with a live queued run bound
    await tick(fx);
    const found = await executionIssues(fx.companyId, fx.routine.id);
    const last = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, fx.routine.id))
      .orderBy(desc(routineRuns.createdAt))
      .limit(1)
      .then((r) => r[0]!);
    expect(found.length).toBe(1);
    expect(last.status).toBe("coalesced");
  });

  // ---- case 17: no cross-tenant suppression ----
  it("ignores a completed issue belonging to another company", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    const otherCompanyId = randomUUID();
    const otherProjectId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "A",
      responsibleUserId: randomUUID(),
    });
    await db.insert(projects).values({ id: otherProjectId, companyId: otherCompanyId, name: "P", status: "in_progress" });
    await db.insert(issues).values({
      companyId: otherCompanyId,
      projectId: otherProjectId,
      title: fx.routine.title,
      description: fx.routine.description ?? "",
      status: "done",
      assigneeAgentId: otherAgentId,
      originKind: "routine_execution",
      originId: fx.routine.id,
      completedAt: new Date(),
    });
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(1);
  });

  // ---- case 19: a suppression must not wedge the schedule ----
  it("still advances nextRunAt when a tick is suppressed", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    await tick(fx);
    await markAllExecutionIssuesDone(fx, new Date());
    await tick(fx);
    const trigger = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.routineId, fx.routine.id))
      .then((r) => r[0]!);
    expect(trigger.nextRunAt).not.toBeNull();
    expect(trigger.nextRunAt!.getTime()).toBeGreaterThan(0);
  });

  // ---- case 4/5: the window boundary, both sides ----
  it("suppresses at the window edge and dispatches one second past it", async () => {
    const inside = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 3600 });
    await tick(inside);
    await markAllExecutionIssuesDone(inside, new Date(Date.now() - 3_599_000));
    await tick(inside);
    expect((await executionIssues(inside.companyId, inside.routine.id)).length).toBe(1);

    const outside = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 3600 });
    await tick(outside);
    await markAllExecutionIssuesDone(outside, new Date(Date.now() - 3_601_000));
    await tick(outside);
    expect((await executionIssues(outside.companyId, outside.routine.id)).length).toBe(2);
  });

  // ---- case 18: a future completion from clock skew must not throw ----
  it("counts a future-dated completion as inside the window", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 3600 });
    await tick(fx);
    await markAllExecutionIssuesDone(fx, new Date(Date.now() + 3_600_000));
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(1);
  });

  // ---- case 10: never link to the finished issue when an open one exists ----
  it("links to the open issue, not the done one, when both exist", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    await tick(fx);
    const [first] = await executionIssues(fx.companyId, fx.routine.id);
    // Age the first one into a finished state but leave it bound to a live run.
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(issues.id, first!.id));
    await tick(fx);
    const last = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, fx.routine.id))
      .orderBy(desc(routineRuns.createdAt))
      .limit(1)
      .then((r) => r[0]!);
    // The finished issue satisfies the trigger. What must never happen is a fresh
    // issue being created, or a run being linked to the finished issue as if it
    // were live work.
    expect(last.status).toBe("skipped");
    expect((last.triggerPayload as { repeatSuppression?: { satisfiedIssueId: string } } | null)
      ?.repeatSuppression?.satisfiedIssueId).toBe(first!.id);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(1);
  });

  // ---- case 14: a human issue with the same title is not this routine's work ----
  it("ignores a done issue that is not a routine execution issue", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    await db.insert(issues).values({
      companyId: fx.companyId,
      projectId: fx.projectId,
      title: fx.routine.title,
      description: fx.routine.description ?? "",
      status: "done",
      assigneeAgentId: fx.agentId,
      originKind: "manual",
      originId: null,
      originFingerprint: "default",
      completedAt: new Date(),
    });
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(1);
  });

  // ---- case 15: another routine's finished work ----
  it("ignores another routine's finished execution issue", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    const otherRoutineId = randomUUID();
    await db.insert(issues).values({
      companyId: fx.companyId,
      projectId: fx.projectId,
      title: "someone else's work",
      description: "different routine",
      status: "done",
      assigneeAgentId: fx.agentId,
      originKind: "routine_execution",
      originId: otherRoutineId,
      originFingerprint: "default",
      completedAt: new Date(),
    });
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(1);
  });

  // ---- case 16: two dispatchers, one tick. The unique index is the safety net. ----
  it("creates at most one issue when two dispatchers race the same tick", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    await tick(fx);
    await markAllExecutionIssuesDone(fx, new Date());
    const results = await Promise.all([fx.svc.runRoutine(fx.routine.id, { source: "manual" } as never), fx.svc.runRoutine(fx.routine.id, { source: "manual" } as never)]);
    expect(results.length).toBe(2);
    // Whichever arm won, the routine must not have produced a second open issue.
    const open = (await executionIssues(fx.companyId, fx.routine.id)).filter((i) => i.status !== "done");
    expect(open.length).toBeLessThanOrEqual(1);
  });

  // ---- the opt-out is reversible: an owner must be able to clear the field ----
  it("clears the repeat policy when explicitly set to null", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    await tick(fx);
    await markAllExecutionIssuesDone(fx, new Date());
    const cleared = await fx.svc.update(fx.routine.id, { repeatPolicy: null, repeatWindowSeconds: null }, {});
    expect(cleared?.repeatPolicy ?? null).toBeNull();
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(2);
  });

  // ---- case 22: the export/import field list is hand-written and easy to miss ----
  it("round-trips the repeat policy through a routine revision restore", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 7200 });
    const before = await fx.svc.listRevisions(fx.routine.id);
    expect(before.length).toBeGreaterThan(0);
    const snapshot = (before[0]!.snapshot as { routine: Record<string, unknown> }).routine;
    expect(snapshot.repeatPolicy).toBe("skip_if_completed");
    expect(snapshot.repeatWindowSeconds).toBe(7200);

    // Clear it, then restore the revision that captured it.
    await fx.svc.update(fx.routine.id, { repeatPolicy: null, repeatWindowSeconds: null }, {});
    await fx.svc.restoreRevision(fx.routine.id, before[0]!.id, {});
    const restored = await fx.svc.get(fx.routine.id);
    expect(restored?.repeatPolicy).toBe("skip_if_completed");
    expect(restored?.repeatWindowSeconds).toBe(7200);
  });

  // ---- the test is only real if it can fail: remove the fix and it must go red ----
  it("NEGATIVE CONTROL: with repeatPolicy cleared the loop re-fires", async () => {
    const fx = await seed({ repeatPolicy: "skip_if_completed", repeatWindowSeconds: 86_400 });
    // Prove the suppression is what stopped the earlier test, not a side effect of ticking.
    await fx.svc.update(fx.routine.id, { repeatPolicy: "always" }, {});
    await tick(fx);
    await markAllExecutionIssuesDone(fx, new Date());
    await tick(fx);
    expect((await executionIssues(fx.companyId, fx.routine.id)).length).toBe(2);
  });
});
