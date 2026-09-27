import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  agentWakeupRequests,
  approvalComments,
  approvals,
  builtInManagedResources,
  companies,
  companySkillVersions,
  companySkills,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  principalPermissionGrants,
  routines,
  routineTriggers,
  issues,
  issueApprovals,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";
import { approvalService } from "../services/approvals.js";
import { attentionService } from "../services/attention.js";
import { readBuiltInAgentMarker } from "../services/built-in-agent-metadata.js";
import { reconcileBuiltInAgentsOnStartup } from "../services/built-in-agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(builtInManagedResources);
    await db.delete(companySkillVersions);
    await db.delete(companySkills);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(approvalComments);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(agentConfigRevisions);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("retries generated issue prefixes when Drizzle wraps the unique constraint error", async () => {
    await db.insert(companies).values({
      name: "Aron Existing",
      issuePrefix: "ARO",
    });

    const created = await companyService(db).create({
      name: "Aron & Sharon",
    });

    expect(created.issuePrefix).toBe("AROA");

    const rows = await db.select({ issuePrefix: companies.issuePrefix }).from(companies);
    expect(rows.map((row) => row.issuePrefix).sort()).toEqual(["ARO", "AROA"]);
  });

  it("auto-provisions one paused Reflection Coach bundle for a freshly created company", async () => {
    const created = await companyService(db).create({
      name: "Fresh Company",
    });

    const agentRows = await db.select().from(agents).where(eq(agents.companyId, created.id));
    const reflectionRows = agentRows.filter((row) => readBuiltInAgentMarker(row.metadata)?.key === "reflection-coach");
    expect(reflectionRows).toHaveLength(1);
    expect(reflectionRows[0]).toMatchObject({
      name: "Reflection Coach",
      status: "paused",
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
    });

    const [skill] = await db
      .select()
      .from(companySkills)
      .where(and(
        eq(companySkills.companyId, created.id),
        eq(companySkills.key, "paperclipai/bundled/paperclip-operations/reflection-coach"),
      ));
    expect(skill).toMatchObject({
      slug: "reflection-coach",
    });

    const [routine] = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, created.id), eq(routines.assigneeAgentId, reflectionRows[0]!.id)));
    expect(routine).toMatchObject({
      status: "paused",
      assigneeAgentId: reflectionRows[0]!.id,
      originKind: "built_in_agent_bundle",
      originId: "reflection-coach:recent-agent-reflection",
    });
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine!.id));
    expect(trigger).toMatchObject({
      kind: "schedule",
      enabled: false,
    });

    await reconcileBuiltInAgentsOnStartup(db);
    const afterReconcileRows = await db.select().from(agents).where(eq(agents.companyId, created.id));
    expect(afterReconcileRows.filter((row) => readBuiltInAgentMarker(row.metadata)?.key === "reflection-coach")).toHaveLength(1);
  });

  it("archives companies by pausing runnable agents and cancelling active runs", async () => {
    const companyId = randomUUID();
    const runningAgentId = randomUUID();
    const idleAgentId = randomUUID();
    const errorAgentId = randomUUID();
    const pausedAgentId = randomUUID();
    const pendingAgentId = randomUUID();
    const terminatedAgentId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Archive Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: runningAgentId,
        companyId,
        name: "Running Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: idleAgentId,
        companyId,
        name: "Idle Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: errorAgentId,
        companyId,
        name: "Error Agent",
        role: "engineer",
        status: "error",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pausedAgentId,
        companyId,
        name: "Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending Agent",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: terminatedAgentId,
        companyId,
        name: "Terminated Agent",
        role: "engineer",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: runningAgentId,
      source: "timer",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: runningAgentId,
      invocationSource: "timer",
      status: "running",
      wakeupRequestId,
    });

    const archived = await companyService(db).archive(companyId, {
      actorType: "user",
      actorId: "test-user",
      agentId: null,
      runId: null,
    });

    expect(archived?.status).toBe("archived");

    const archiveActivity = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({
      actorType: "user",
      actorId: "test-user",
      details: { agentsPaused: 3, runsCancelled: 1 },
    });

    const rows = await db
      .select({
        id: agents.id,
        status: agents.status,
        pauseReason: agents.pauseReason,
      })
      .from(agents);

    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(runningAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(idleAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(errorAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(pausedAgentId)).toMatchObject({ status: "paused", pauseReason: "manual" });
    expect(byId.get(pendingAgentId)).toMatchObject({ status: "pending_approval", pauseReason: null });
    expect(byId.get(terminatedAgentId)).toMatchObject({ status: "terminated", pauseReason: null });

    const run = await db
      .select({
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .then((result) => result[0] ?? null);
    expect(run).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });

    const wakeup = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .then((result) => result[0] ?? null);
    expect(wakeup).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });
  });

  it("reactivates only agents paused because the company was archived", async () => {
    const companyId = randomUUID();
    const archivedPausedAgentId = randomUUID();
    const manualPausedAgentId = randomUUID();
    const pendingAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reactivate Test Co",
      status: "archived",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: archivedPausedAgentId,
        companyId,
        name: "Archived Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: manualPausedAgentId,
        companyId,
        name: "Manual Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending Approval Agent",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const reactivateActivity = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(1);
    expect(reactivateActivity[0]).toMatchObject({
      actorType: "user",
      actorId: "test-user",
      details: { agentsRestored: 1 },
    });

    const rows = await db
      .select({
        id: agents.id,
        status: agents.status,
        pauseReason: agents.pauseReason,
        pausedAt: agents.pausedAt,
      })
      .from(agents);

    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(archivedPausedAgentId)).toMatchObject({
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    });
    expect(byId.get(manualPausedAgentId)).toMatchObject({
      status: "paused",
      pauseReason: "manual",
    });
    expect(byId.get(pendingAgentId)).toMatchObject({
      status: "pending_approval",
      pauseReason: null,
    });
  });

  it("runs the archive cascade when update() transitions a company to archived", async () => {
    const companyId = randomUUID();
    const runningAgentId = randomUUID();
    const idleAgentId = randomUUID();
    const pendingAgentId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Update Archive Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: runningAgentId,
        companyId,
        name: "Running Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: idleAgentId,
        companyId,
        name: "Idle Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending Agent",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: runningAgentId,
      source: "timer",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: runningAgentId,
      invocationSource: "timer",
      status: "running",
      wakeupRequestId,
    });

    const archived = await companyService(db).update(
      companyId,
      { status: "archived" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(archived?.status).toBe("archived");

    const rows = await db
      .select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(runningAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(idleAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(pendingAgentId)).toMatchObject({ status: "pending_approval", pauseReason: null });

    const run = await db
      .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .then((result) => result[0] ?? null);
    expect(run).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });

    const archiveActivity = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({
      actorType: "user",
      actorId: "test-user",
      details: { agentsPaused: 2, runsCancelled: 1 },
    });
  });

  it("reactivates company_archived agents even when going via paused state (archived → paused → active)", async () => {
    const companyId = randomUUID();
    const archivedPausedAgentId = randomUUID();
    const manualPausedAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Indirect Reactivate Test Co",
      status: "paused",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: archivedPausedAgentId,
        companyId,
        name: "Archived Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: manualPausedAgentId,
        companyId,
        name: "Manual Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const rows = await db
      .select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(archivedPausedAgentId)).toMatchObject({ status: "idle", pauseReason: null });
    expect(byId.get(manualPausedAgentId)).toMatchObject({ status: "paused", pauseReason: "manual" });

    const reactivateActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(1);
    expect(reactivateActivity[0]).toMatchObject({ details: { agentsRestored: 1 } });
  });

  it("emits company.reactivated for archived → active even when no agents need restoring", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Empty Reactivate Co",
      status: "archived",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: terminatedAgentId,
      companyId,
      name: "Terminated Agent",
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const reactivateActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(1);
    expect(reactivateActivity[0]).toMatchObject({ details: { agentsRestored: 0 } });
  });

  it("does not emit company.reactivated when paused → active restores no archive-paused agents", async () => {
    const companyId = randomUUID();
    const manualPausedAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plain Unpause Co",
      status: "paused",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: manualPausedAgentId,
      companyId,
      name: "Manual Paused Agent",
      role: "engineer",
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date("2026-06-01T00:00:00Z"),
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const reactivateActivity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(0);

    const agent = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .then((rows) => rows[0] ?? null);
    expect(agent).toMatchObject({ status: "paused", pauseReason: "manual" });
  });

  it("cancels orphan queued wakeup requests with no runId during archive", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const orphanWakeupId = randomUUID();
    const runWakeupId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Orphan Wakeup Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Idle Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values([
      {
        id: orphanWakeupId,
        companyId,
        agentId,
        source: "automation",
        status: "queued",
      },
      {
        id: runWakeupId,
        companyId,
        agentId,
        source: "timer",
        status: "queued",
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "running",
      wakeupRequestId: runWakeupId,
    });

    const archived = await companyService(db).archive(companyId, {
      actorType: "user",
      actorId: "test-user",
      agentId: null,
      runId: null,
    });
    expect(archived?.status).toBe("archived");

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests);
    const byId = new Map(wakeups.map((row) => [row.id, row]));
    expect(byId.get(orphanWakeupId)).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });
    expect(byId.get(runWakeupId)).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });
  });

  it("archive() is idempotent — re-archiving emits no second cascade or activity entry", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Idempotent Archive Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Idle Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const actor = { actorType: "user" as const, actorId: "test-user", agentId: null, runId: null };
    const first = await companyService(db).archive(companyId, actor);
    expect(first?.status).toBe("archived");

    const second = await companyService(db).archive(companyId, actor);
    expect(second?.status).toBe("archived");

    const archiveActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({ details: { agentsPaused: 1, runsCancelled: 0 } });
  });

  it("runs the archive cascade when update() transitions a paused company to archived", async () => {
    const companyId = randomUUID();
    const idleAgentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paused To Archived Test Co",
      status: "paused",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: idleAgentId,
      companyId,
      name: "Idle Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: idleAgentId,
      invocationSource: "timer",
      status: "queued",
    });

    const archived = await companyService(db).update(
      companyId,
      { status: "archived" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(archived?.status).toBe("archived");

    const agent = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .then((rows) => rows[0] ?? null);
    expect(agent).toMatchObject({ status: "paused", pauseReason: "company_archived" });

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("cancelled");

    const archiveActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({
      details: { agentsPaused: 1, runsCancelled: 1 },
    });
  });

  it("requires an exact holding marker before projecting any operator records", async () => {
    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const genericEscalationIssueId = randomUUID();

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Worker Tool Publisher",
        description: "AgentSwarm provisioned business digital_services_products_worker_tool_publisher\n\nagentswarm:business=digital_services_products_worker_tool_publisher",
        issuePrefix: `W${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: targetCompanyId,
        name: "Digital Services Products — Holding",
        description: "AgentSwarm holding authority\n\nagentswarm:holding-provider-onboarding-company=digital_services_products_other",
        issuePrefix: `D${targetCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId: sourceCompanyId,
      name: "Worker Tool Provisioner",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId: sourceCompanyId,
      name: "Worker Tool Publisher",
      leadAgentId: agentId,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: sourceCompanyId,
      projectId,
      assigneeAgentId: agentId,
      title: "Existing provider onboarding work",
      description: "AgentSwarm run: run_legacy\nStage: provider-onboarding",
      identifier: "WOR-3",
    });
    await db.insert(issues).values({
      id: genericEscalationIssueId,
      companyId: sourceCompanyId,
      projectId,
      assigneeAgentId: agentId,
      title: "Decision required: generic agent escalation",
      description: "Agent-authored request without a formal Paperclip approval.",
      identifier: "WOR-4",
      status: "in_review",
    });

    await expect(companyService(db).consolidateLegacyAgentSwarmBusiness({
      sourceCompanyId,
      targetCompanyId,
      businessId: "digital_services_products_worker_tool_publisher",
      holdingId: "digital_services_products",
      actor: {
        actorType: "system",
        actorId: "agentswarm-holding-reconciler",
        agentId: null,
        runId: null,
      },
    })).rejects.toThrow("Company markers do not authorize this AgentSwarm consolidation");
    await expect(companyService(db).getById(sourceCompanyId)).resolves.toMatchObject({
      id: sourceCompanyId,
      status: "active",
      operatorVisible: true,
    });

    const [migratedAgent] = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, agentId));
    const [migratedProject] = await db
      .select({ companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId));
    const [migratedIssue] = await db
      .select({ companyId: issues.companyId, projectId: issues.projectId, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(migratedAgent).toEqual({ companyId: sourceCompanyId });
    expect(migratedProject).toEqual({ companyId: sourceCompanyId });
    expect(migratedIssue).toEqual({
      companyId: sourceCompanyId,
      projectId,
      assigneeAgentId: agentId,
    });
    const [retainedEscalation] = await db
      .select({ companyId: issues.companyId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, genericEscalationIssueId));
    expect(retainedEscalation).toEqual({ companyId: sourceCompanyId, status: "in_review" });
  });

  it("hides an already archived legacy source and retains the consolidated response", async () => {
    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Archived Worker Tool Publisher",
        status: "archived",
        description: "agentswarm:business=digital_services_products_worker_tool_publisher",
        issuePrefix: `W${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      },
      {
        id: targetCompanyId,
        name: "Digital Services Products — Holding",
        description: "agentswarm:holding-provider-onboarding-company=digital_services_products",
        issuePrefix: `D${targetCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      },
    ]);
    const input = {
      sourceCompanyId,
      targetCompanyId,
      businessId: "digital_services_products_worker_tool_publisher",
      holdingId: "digital_services_products",
      actor: { actorType: "system" as const, actorId: "agentswarm-holding-reconciler", agentId: null, runId: null },
    };
    await expect(companyService(db).consolidateLegacyAgentSwarmBusiness(input)).resolves.toEqual({
      state: "consolidated", sourceCompanyId, targetCompanyId, sourceCompanyArchived: true,
    });
    await expect(companyService(db).getById(sourceCompanyId)).resolves.toMatchObject({
      status: "archived", operatorVisible: false, operatorCompanyId: targetCompanyId,
    });
    await companyService(db).consolidateLegacyAgentSwarmBusiness(input);
    const logs = await db.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, targetCompanyId),
      eq(activityLog.action, "company.legacy_agentswarm_operator_surface_projected"),
    ));
    expect(logs).toHaveLength(1);
  });

  it("projects the operator surface even while the source company has an active execution", async () => {
    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Worker Tool Publisher",
        description: "AgentSwarm provisioned business digital_services_products_worker_tool_publisher\n\nagentswarm:business=digital_services_products_worker_tool_publisher",
        issuePrefix: `W${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: targetCompanyId,
        name: "Digital Services Products — Holding",
        description: "AgentSwarm holding authority\n\nagentswarm:holding-provider-onboarding-company=digital_services_products",
        issuePrefix: `D${targetCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId: sourceCompanyId,
      name: "Worker Tool Provisioner",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      companyId: sourceCompanyId,
      agentId,
      invocationSource: "timer",
      status: "running",
    });

    await expect(companyService(db).consolidateLegacyAgentSwarmBusiness({
      sourceCompanyId,
      targetCompanyId,
      businessId: "digital_services_products_worker_tool_publisher",
      holdingId: "digital_services_products",
      actor: { actorType: "system", actorId: "agentswarm-holding-reconciler", agentId: null, runId: null },
    })).resolves.toMatchObject({
      state: "runtime_deferred",
      sourceCompanyId,
      targetCompanyId,
    });

    await expect(companyService(db).getById(sourceCompanyId)).resolves.toMatchObject({
      id: sourceCompanyId,
      status: "active",
      operatorVisible: false,
      operatorCompanyId: targetCompanyId,
    });
    const [agent] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId));
    expect(agent).toEqual({ companyId: sourceCompanyId });
  });

  it("projects formal approvals to the marked holding without moving a live source runtime", async () => {
    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const approvalId = randomUUID();

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Worker Tool Publisher",
        description: "agentswarm:business=digital_services_products_worker_tool_publisher",
        issuePrefix: `W${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      },
      {
        id: targetCompanyId,
        name: "Digital Services Products — Holding",
        description: "agentswarm:holding-provider-onboarding-company=digital_services_products",
        issuePrefix: `D${targetCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId: sourceCompanyId,
      name: "Executor Provisioner",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: sourceCompanyId,
      assigneeAgentId: agentId,
      title: "Runtime stage",
      identifier: "WOR-12",
    });
    await db.insert(heartbeatRuns).values({
      companyId: sourceCompanyId,
      agentId,
      invocationSource: "timer",
      status: "scheduled_retry",
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId: sourceCompanyId,
      type: "provider_commitment",
      requestedByAgentId: agentId,
      payload: { provider: "cloudflare" },
    });
    await db.insert(issueApprovals).values({
      companyId: sourceCompanyId,
      issueId,
      approvalId,
      linkedByAgentId: agentId,
    });
    await db.insert(approvalComments).values({
      companyId: sourceCompanyId,
      approvalId,
      authorAgentId: agentId,
      body: "Formal operator decision",
    });

    await expect(companyService(db).consolidateLegacyAgentSwarmBusiness({
      sourceCompanyId,
      targetCompanyId,
      businessId: "digital_services_products_worker_tool_publisher",
      holdingId: "digital_services_products",
      actor: { actorType: "system", actorId: "agentswarm-holding-reconciler", agentId: null, runId: null },
    })).resolves.toMatchObject({ state: "runtime_deferred", sourceCompanyId, targetCompanyId });

    await expect(db.select({
      status: companies.status,
      operatorVisible: companies.operatorVisible,
      operatorCompanyId: companies.operatorCompanyId,
    }).from(companies).where(eq(companies.id, sourceCompanyId))).resolves.toEqual([
      { status: "active", operatorVisible: false, operatorCompanyId: targetCompanyId },
    ]);
    await expect(db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId))).resolves.toEqual([
      { companyId: sourceCompanyId },
    ]);
    await expect(db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      { companyId: sourceCompanyId },
    ]);
    await expect(db.select({ companyId: heartbeatRuns.companyId }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).resolves.toEqual([
      { companyId: sourceCompanyId },
    ]);
    await expect(db.select({ companyId: approvals.companyId, operatorCompanyId: approvals.operatorCompanyId }).from(approvals).where(eq(approvals.id, approvalId))).resolves.toEqual([
      { companyId: sourceCompanyId, operatorCompanyId: targetCompanyId },
    ]);
    await expect(db.select({ companyId: issueApprovals.companyId }).from(issueApprovals).where(eq(issueApprovals.approvalId, approvalId))).resolves.toEqual([
      { companyId: sourceCompanyId },
    ]);
    await expect(db.select({ companyId: approvalComments.companyId }).from(approvalComments).where(eq(approvalComments.approvalId, approvalId))).resolves.toEqual([
      { companyId: sourceCompanyId },
    ]);

    const holdingApprovals = await approvalService(db).list(targetCompanyId, "pending");
    expect(holdingApprovals.map((approval) => approval.id)).toContain(approvalId);
    const sourceApprovals = await approvalService(db).list(sourceCompanyId, "pending");
    expect(sourceApprovals.map((approval) => approval.id)).toContain(approvalId);
    const [laterApproval] = await db.insert(approvals).values({
      companyId: sourceCompanyId,
      type: "provider_commitment",
      requestedByAgentId: agentId,
      payload: { provider: "cloudflare", stage: "later" },
    }).returning();
    expect(laterApproval.operatorCompanyId).toBe(targetCompanyId);
    expect((await approvalService(db).list(targetCompanyId, "pending")).map((approval) => approval.id))
      .toContain(laterApproval.id);
    const holdingFeed = await attentionService(db).list(targetCompanyId, { userId: "board-user" });
    expect(holdingFeed.items.some((item) => item.sourceKind === "approval" && item.subject.id === approvalId)).toBe(true);

    await expect(companyService(db).consolidateLegacyAgentSwarmBusiness({
      sourceCompanyId,
      targetCompanyId,
      businessId: "digital_services_products_worker_tool_publisher",
      holdingId: "digital_services_products",
      actor: { actorType: "system", actorId: "agentswarm-holding-reconciler", agentId: null, runId: null },
    })).resolves.toMatchObject({ state: "runtime_deferred" });
    const projectionLogs = await db.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, targetCompanyId),
      eq(activityLog.action, "company.legacy_agentswarm_operator_surface_projected"),
    ));
    expect(projectionLogs).toHaveLength(1);
  });
});
