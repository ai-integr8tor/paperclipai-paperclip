import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres write-authorization-without-lock-theft tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("sibling write authorization does not steal the holder's lock", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-no-lock-theft-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  /**
   * `holderRunId` is a live run of `assigneeAgentId` that holds the checkout.
   * `siblingRunIds` are further live runs of the SAME agent (the actors), plus one
   * live run of a different agent for the cross-agent negatives.
   */
  async function seed(input: {
    checkoutRunId?: string | null;
    issueStatus?: string;
    assignTo?: string | null;
    siblingCount?: number;
  }) {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const holderRunId = randomUUID();
    const siblingRunIds = Array.from({ length: input.siblingCount ?? 1 }, () => randomUUID());
    const otherAgentRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: holderRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      ...siblingRunIds.map((id) => ({
        id,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      })),
      {
        id: otherAgentRunId,
        companyId,
        agentId: otherAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    const checkoutRunId =
      input.checkoutRunId === undefined ? holderRunId : input.checkoutRunId;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Held issue",
      status: input.issueStatus ?? "in_progress",
      priority: "high",
      assigneeAgentId:
        input.assignTo === undefined
          ? assigneeAgentId
          : input.assignTo === "other"
            ? otherAgentId
            : input.assignTo,
      checkoutRunId,
      executionRunId: checkoutRunId,
      executionLockedAt: checkoutRunId ? new Date() : null,
    });
    // The cross-issue influence guard attributes writes to the run's source issue.
    for (const runId of [holderRunId, ...siblingRunIds, otherAgentRunId]) {
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: { issueId } })
        .where(eq(heartbeatRuns.id, runId));
    }

    return {
      companyId,
      issueId,
      assigneeAgentId,
      otherAgentId,
      holderRunId,
      siblingRunIds,
      otherAgentRunId,
    };
  }

  const agentActor = (companyId: string, agentId: string, runId: string) =>
    ({ type: "agent", agentId, companyId, runId, source: "agent_jwt" }) as Express.Request["actor"];

  const readIssue = (issueId: string) =>
    db
      .select({
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);

  // ── A. the defect, pinned ────────────────────────────────────────────────

  // A1. The sibling CAN write — and the lock does not move. This is the whole
  // issue: the write is authorized, and the live holder keeps its issue.
  it("A1 authorizes a sibling write without moving the lock off the live holder", async () => {
    const s = await seed({});
    const res = await request(
      createApp(agentActor(s.companyId, s.assigneeAgentId, s.siblingRunIds[0]!)),
    )
      .patch(`/api/issues/${s.issueId}`)
      .send({ title: "Written by sibling run" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Written by sibling run");

    const row = await readIssue(s.issueId);
    expect(row?.title).toBe("Written by sibling run");
    // The holder keeps the lock. This is the assertion that fails on the defect.
    expect(row?.checkoutRunId).toBe(s.holderRunId);
    expect(row?.executionRunId).toBe(s.holderRunId);
    expect(row?.status).toBe("in_progress");
    expect(row?.assigneeAgentId).toBe(s.assigneeAgentId);
  });

  // A2. Repeated writes by the sibling are idempotent — the lock must never
  // drift to the actor no matter how many times the agent retries.
  it("A2 a repeated sibling write never migrates the lock to the actor", async () => {
    const s = await seed({});
    const app = createApp(agentActor(s.companyId, s.assigneeAgentId, s.siblingRunIds[0]!));
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .patch(`/api/issues/${s.issueId}`)
        .send({ title: `attempt ${i}` });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const row = await readIssue(s.issueId);
    expect(row?.checkoutRunId).toBe(s.holderRunId);
    expect(row?.executionRunId).toBe(s.holderRunId);
  });

  // A3. A sibling comment is also a write, and must not take the lock either.
  it("A3 a sibling comment does not move the lock", async () => {
    const s = await seed({});
    const res = await request(
      createApp(agentActor(s.companyId, s.assigneeAgentId, s.siblingRunIds[0]!)),
    )
      .post(`/api/issues/${s.issueId}/comments`)
      .send({ body: "sibling comment" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await readIssue(s.issueId);
    expect(row?.checkoutRunId).toBe(s.holderRunId);
  });

  // ── B. pre-existing behaviour that must not regress ──────────────────────

  // B1/B2. The actual holder keeps every power it had.
  it("B1 the holder still writes and still releases its own lock", async () => {
    const s = await seed({});
    const app = createApp(agentActor(s.companyId, s.assigneeAgentId, s.holderRunId));
    const patch = await request(app)
      .patch(`/api/issues/${s.issueId}`)
      .send({ title: "Written by the holder" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);

    const release = await request(app).post(`/api/issues/${s.issueId}/release`);
    expect(release.status, JSON.stringify(release.body)).toBe(200);
    const row = await readIssue(s.issueId);
    expect(row?.checkoutRunId).toBeNull();
  });

  // B3/B4/B5. The stale-lock escape routes are untouched: a terminal or missing
  // holder still yields its lock, and that is the one path that SHOULD write.
  it.each(["succeeded", "interrupted", "failed", "cancelled", "timed_out"])(
    "B3 adopts the lock when the holder run is terminal (%s)",
    async (terminalStatus) => {
      const s = await seed({});
      await db
        .update(heartbeatRuns)
        .set({ status: terminalStatus })
        .where(eq(heartbeatRuns.id, s.holderRunId));

      const svc = issueService(db);
      await expect(
        svc.assertCheckoutOwner(s.issueId, s.assigneeAgentId, s.siblingRunIds[0]!),
      ).resolves.toMatchObject({ checkoutRunId: s.siblingRunIds[0] });

      const row = await readIssue(s.issueId);
      expect(row?.checkoutRunId).toBe(s.siblingRunIds[0]);
    },
  );

  it("B4 adopts the lock when the holder run row is missing entirely", async () => {
    const s = await seed({});
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, s.holderRunId));

    const svc = issueService(db);
    await expect(
      svc.assertCheckoutOwner(s.issueId, s.assigneeAgentId, s.siblingRunIds[0]!),
    ).resolves.toMatchObject({ checkoutRunId: s.siblingRunIds[0] });
  });

  it("B5 adopts an unowned in_progress checkout as before", async () => {
    const s = await seed({ checkoutRunId: null });
    const svc = issueService(db);
    await expect(
      svc.assertCheckoutOwner(s.issueId, s.assigneeAgentId, s.siblingRunIds[0]!),
    ).resolves.toMatchObject({ checkoutRunId: s.siblingRunIds[0] });
    const row = await readIssue(s.issueId);
    expect(row?.checkoutRunId).toBe(s.siblingRunIds[0]);
  });

  // ── C. boundaries and negatives ──────────────────────────────────────────

  it("C1 a TERMINAL actor run gains nothing from the sibling path", async () => {
    const s = await seed({});
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, s.siblingRunIds[0]!));

    const svc = issueService(db);
    await expect(
      svc.assertCheckoutOwner(s.issueId, s.assigneeAgentId, s.siblingRunIds[0]!),
    ).rejects.toMatchObject({ status: 409 });
    const row = await readIssue(s.issueId);
    expect(row?.checkoutRunId).toBe(s.holderRunId);
  });

  it.each(["todo", "blocked", "in_review", "done"])(
    "C2 a sibling gains nothing when the issue is %s",
    async (issueStatus) => {
      const s = await seed({ issueStatus });
      const svc = issueService(db);
      await expect(
        svc.assertCheckoutOwner(s.issueId, s.assigneeAgentId, s.siblingRunIds[0]!),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it("C3 a sibling gains nothing when the issue is assigned to another agent", async () => {
    // Assigned to the OTHER agent, so the acting agent is not the assignee and the
    // same-agent sibling admission cannot apply at all.
    const s = await seed({ assignTo: "other" });
    const svc = issueService(db);
    await expect(
      svc.assertCheckoutOwner(s.issueId, s.otherAgentId, s.otherAgentRunId),
    ).rejects.toMatchObject({ status: 409 });
    const row = await readIssue(s.issueId);
    expect(row?.checkoutRunId).toBe(s.holderRunId);
  });

  it("C4 an unscoped actor (null runId) gains nothing", async () => {
    const s = await seed({});
    const svc = issueService(db);
    await expect(
      svc.assertCheckoutOwner(s.issueId, s.assigneeAgentId, null),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("C5 a different agent gains nothing even though its run is live", async () => {
    const s = await seed({});
    const svc = issueService(db);
    await expect(
      svc.assertCheckoutOwner(s.issueId, s.otherAgentId, s.otherAgentRunId),
    ).rejects.toMatchObject({ status: 409 });
    const row = await readIssue(s.issueId);
    expect(row?.checkoutRunId).toBe(s.holderRunId);
  });

  it("C6 a null assignee gains nothing", async () => {
    const s = await seed({ assignTo: null });
    const svc = issueService(db);
    await expect(
      svc.assertCheckoutOwner(s.issueId, s.assigneeAgentId, s.siblingRunIds[0]!),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("C7 a sibling is authorized when executionRunId points elsewhere", async () => {
    const s = await seed({});
    // checkoutRunId is the live holder; executionRunId belongs to somebody else.
    await db
      .update(issues)
      .set({ executionRunId: s.otherAgentRunId })
      .where(eq(issues.id, s.issueId));

    const svc = issueService(db);
    await expect(
      svc.assertCheckoutOwner(s.issueId, s.assigneeAgentId, s.siblingRunIds[0]!),
    ).resolves.toMatchObject({ id: s.issueId });
    const row = await readIssue(s.issueId);
    // Neither column may be overwritten by an authorization.
    expect(row?.checkoutRunId).toBe(s.holderRunId);
    expect(row?.executionRunId).toBe(s.otherAgentRunId);
  });

  // ── D. concurrency ───────────────────────────────────────────────────────

  it("D1 concurrent sibling writes all succeed and none steals the lock", async () => {
    const s = await seed({ siblingCount: 3 });
    const results = await Promise.all(
      s.siblingRunIds.map((runId, i) =>
        request(createApp(agentActor(s.companyId, s.assigneeAgentId, runId)))
          .patch(`/api/issues/${s.issueId}`)
          .send({ title: `concurrent ${i}` }),
      ),
    );
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = await readIssue(s.issueId);
    expect(row?.checkoutRunId).toBe(s.holderRunId);
    expect(row?.executionRunId).toBe(s.holderRunId);
    expect(row?.status).toBe("in_progress");
  });

  // D2. The grant is not sticky state. Releasing clears the lock, so the sibling
  // falls back to the ordinary unowned-checkout path and the row it leaves behind
  // is the ordinary one. What must NOT happen is the sibling ending up holding a
  // lock it never legitimately acquired.
  it("D2 a release leaves the sibling with no lock it did not legitimately take", async () => {
    const s = await seed({});
    const held = await request(
      createApp(agentActor(s.companyId, s.assigneeAgentId, s.siblingRunIds[0]!)),
    )
      .patch(`/api/issues/${s.issueId}`)
      .send({ title: "authorized while the holder is live" });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    // The sibling's write left the holder's lock exactly where it was.
    expect((await readIssue(s.issueId))?.checkoutRunId).toBe(s.holderRunId);

    await request(
      createApp(agentActor(s.companyId, s.assigneeAgentId, s.holderRunId)),
    ).post(`/api/issues/${s.issueId}/release`);

    const row = await readIssue(s.issueId);
    expect(row?.checkoutRunId).toBeNull();
    expect(row?.status).toBe("todo");
    expect(row?.assigneeAgentId).toBeNull();
  });

  // ── E. degenerate ────────────────────────────────────────────────────────

  it("E1 a missing issue is a 404, not a crash", async () => {
    const s = await seed({});
    const svc = issueService(db);
    await expect(
      svc.assertCheckoutOwner(randomUUID(), s.assigneeAgentId, s.siblingRunIds[0]!),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("E2 a missing actor run row grants nothing", async () => {
    const s = await seed({});
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, s.siblingRunIds[0]!));
    const svc = issueService(db);
    await expect(
      svc.assertCheckoutOwner(s.issueId, s.assigneeAgentId, s.siblingRunIds[0]!),
    ).rejects.toMatchObject({ status: 409 });
    const row = await readIssue(s.issueId);
    expect(row?.checkoutRunId).toBe(s.holderRunId);
  });
});
