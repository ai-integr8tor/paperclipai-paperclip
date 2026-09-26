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
    `Skipping embedded Postgres same-agent live sibling checkout tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("same-agent live sibling checkout lock", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-same-agent-live-sibling-");
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

  async function seedCompanyAgentsAndRuns() {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const siblingRunId = randomUUID();
    const actorRunId = randomUUID();
    const otherAgentRunId = randomUUID();

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
    // The holder is a LIVE run of the SAME agent; the actor is a second live run
    // of that same agent. The other agent's run is also live so the negative case
    // cannot pass merely because the run is missing.
    await db.insert(heartbeatRuns).values([
      {
        id: siblingRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: actorRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: otherAgentRunId,
        companyId,
        agentId: otherAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return {
      companyId,
      assigneeAgentId,
      otherAgentId,
      siblingRunId,
      actorRunId,
      otherAgentRunId,
    };
  }

  function agentActor(
    companyId: string,
    agentId: string,
    runId: string,
  ): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  async function seedIssue(input: {
    companyId: string;
    assigneeAgentId: string;
    checkoutRunId: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Sibling-held issue",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.assigneeAgentId,
      checkoutRunId: input.checkoutRunId,
      executionRunId: input.checkoutRunId,
      executionLockedAt: new Date(),
    });
    return issueId;
  }

  // The assignee must be able to write its own issue even
  // when a concurrently live run of the SAME agent holds the checkout.
  it("lets a live sibling run of the same assignee agent PATCH the issue", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    // The cross-issue influence guard attributes writes to the run's source issue.
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, seed.actorRunId));

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Written by sibling run" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Written by sibling run");

    const row = await db
      .select({ title: issues.title, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.title).toBe("Written by sibling run");
    expect(row?.checkoutRunId).toBe(seed.actorRunId);
  });

  it("lets the same assignee agent comment on an issue held by a live sibling run", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    // The cross-issue influence guard attributes writes to the run's source issue.
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, seed.actorRunId));

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Sibling run comment" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("still refuses a live checkout held by a DIFFERENT agent", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.otherAgentRunId,
    });

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should be refused" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Issue run ownership conflict");
  });

  // The case a reviewer must not lose: a correct
  // cross-agent lock must still refuse. The actor is NOT the assignee, so the
  // same-agent sibling admission must not apply.
  it("refuses a PATCH from a DIFFERENT agent than the assignee, even when a live same-agent sibling holds the lock", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    // The assignee's own live sibling run holds the checkout.
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, seed.otherAgentRunId));

    // The actor is the OTHER agent — not the assignee.
    const res = await request(
      createApp(agentActor(seed.companyId, seed.otherAgentId, seed.otherAgentRunId)),
    )
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Cross-agent write must be refused" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.code).toBe("issue_write_assignee_run_lock");
    // The falsification discriminator at the route layer: a correct refusal names
    // a different actor than the assignee.
    expect(res.body.details?.actorAgentId).toBe(seed.otherAgentId);
    expect(res.body.details?.assigneeAgentId).toBe(seed.assigneeAgentId);
    expect(res.body.details?.actorAgentId).not.toBe(
      res.body.details?.assigneeAgentId,
    );

    const row = await db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.title).toBe("Sibling-held issue");
  });

  // The same cross-agent refusal asserted directly against the service, so the
  // guarantee is pinned to assertCheckoutOwner itself and not only to whichever
  // route guard happens to run first. This is the falsification discriminator:
  // a correct refusal names a different actor than the assignee, while the
  // original defect refuses with actor == assignee.
  it("assertCheckoutOwner refuses a non-assignee agent even when a live same-agent sibling holds the lock", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    const svc = issueService(db);

    // The assignee's sibling run: admitted.
    await expect(
      svc.assertCheckoutOwner(issueId, seed.assigneeAgentId, seed.actorRunId),
    ).resolves.toMatchObject({ checkoutRunId: seed.actorRunId });

    // A different agent: refused, and the refusal names the true actor.
    await expect(
      svc.assertCheckoutOwner(issueId, seed.otherAgentId, seed.otherAgentRunId),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        actorAgentId: seed.otherAgentId,
        assigneeAgentId: seed.assigneeAgentId,
      },
    });
  });

  it("refuses to release a lock held by a LIVE sibling run of the same agent", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/release`);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Only checkout run can release issue");
    // The holder is still running: it must keep its issue, its assignee and its
    // checkout. A release here would hand a still-active run's work to anyone.
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBe(seed.siblingRunId);
    expect(row?.assigneeAgentId).toBe(seed.assigneeAgentId);
    expect(row?.status).toBe("in_progress");
  });

  it("still releases when the holder run has gone terminal (stale-lock escape route)", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    // "succeeded" is a status the product actually writes on a run. (An earlier
    // draft of this test used "completed", which is not in
    // TERMINAL_HEARTBEAT_RUN_STATUSES and is never written to heartbeat_runs —
    // it made the stale path look broken when the guard was correct.)
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, seed.siblingRunId));

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/release`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBeNull();
  });

  // The stale escape route must hold for EVERY terminal status the product
  // writes, not just one. A status the guard fails to recognise would strand a
  // finished run's issue forever, which is the wedge this change must not cause.
  it.each(["succeeded", "interrupted", "failed", "cancelled", "timed_out"])(
    "still releases when the holder run is terminal (%s)",
    async (terminalStatus) => {
      const seed = await seedCompanyAgentsAndRuns();
      const issueId = await seedIssue({
        companyId: seed.companyId,
        assigneeAgentId: seed.assigneeAgentId,
        checkoutRunId: seed.siblingRunId,
      });
      await db
        .update(heartbeatRuns)
        .set({ status: terminalStatus })
        .where(eq(heartbeatRuns.id, seed.siblingRunId));

      const res = await request(
        createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
      )
        .post(`/api/issues/${issueId}/release`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = await db
        .select({ checkoutRunId: issues.checkoutRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row?.checkoutRunId).toBeNull();
    },
  );

  // A queued sibling has not started, but it is not terminal either. It holds a
  // claim on the issue, so release must refuse just as it does for `running`.
  it.each(["queued", "retrying", "pending_cleanup"])(
    "refuses to release when the holder run is non-terminal but not running (%s)",
    async (nonTerminalStatus) => {
      const seed = await seedCompanyAgentsAndRuns();
      const issueId = await seedIssue({
        companyId: seed.companyId,
        assigneeAgentId: seed.assigneeAgentId,
        checkoutRunId: seed.siblingRunId,
      });
      await db
        .update(heartbeatRuns)
        .set({ status: nonTerminalStatus })
        .where(eq(heartbeatRuns.id, seed.siblingRunId));

      const res = await request(
        createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
      )
        .post(`/api/issues/${issueId}/release`);

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      const row = await db
        .select({ checkoutRunId: issues.checkoutRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row?.checkoutRunId).toBe(seed.siblingRunId);
    },
  );

  // The holder is the actor's own run: releasing is the normal way an agent
  // drops a lock it legitimately holds, and it must keep working.
  it("still releases when the holder is the actor's OWN run", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.actorRunId,
    });

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/release`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBeNull();
  });

  // A refused release must not write ANY column. Partial state here is how an
  // issue ends up assignee-less but still locked, or locked but re-queued.
  it("a refused release leaves every column untouched", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/release`);

    expect(res.status).toBe(409);
    const row = await db
      .select({
        title: issues.title,
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({
      title: "Sibling-held issue",
      status: "in_progress",
      checkoutRunId: seed.siblingRunId,
      executionRunId: seed.siblingRunId,
      assigneeAgentId: seed.assigneeAgentId,
    });
    expect(row?.executionLockedAt).not.toBeNull();
  });

  // Two releases racing the same live holder: at most one may win, and the
  // holder must never be left half-cleared.
  it("concurrent releases against a live holder do not corrupt the lock", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    const app = createApp(
      agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId),
    );

    const results = await Promise.all([
      request(app).post(`/api/issues/${issueId}/release`),
      request(app).post(`/api/issues/${issueId}/release`),
    ]);
    for (const r of results) expect(r.status).toBe(409);

    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBe(seed.siblingRunId);
    expect(row?.status).toBe("in_progress");
  });

  it("still releases when the holder run row is missing entirely", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, seed.siblingRunId));

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/release`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("still refuses to release when the holder is a live run of a DIFFERENT agent", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.otherAgentRunId,
    });

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/release`);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
  });

  // Opting out of run-lock ADOPTION must not opt out of the actor-liveness check
  // that assertCheckoutOwner performs on the way through. That check refuses a
  // terminal or missing actor run from taking over a checkout. Without it a dead
  // run can clear a stale-held issue, because the release route no longer
  // verifies the caller is still alive before dropping the holder's lock.
  it("refuses to release when the ACTOR's own run is terminal and the holder is stale", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    // Both runs are dead, so the issue is stale and a LIVE actor would be
    // allowed to release it. Only the actor's own liveness is under test here.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, seed.actorRunId));
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, seed.siblingRunId));

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/release`);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row[0]?.status).toBe("in_progress");
    expect(row[0]?.checkoutRunId).toBe(seed.siblingRunId);
    expect(row[0]?.assigneeAgentId).toBe(seed.assigneeAgentId);
  });

  it("refuses to release when the ACTOR's run row is missing entirely", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, seed.siblingRunId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, seed.actorRunId));

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/release`);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const row = await db
      .select({ status: issues.status, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(row[0]?.status).toBe("in_progress");
    expect(row[0]?.checkoutRunId).toBe(seed.siblingRunId);
  });
});
