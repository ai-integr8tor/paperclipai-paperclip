import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentConfigRevisions, agents, approvals, companies, createDb,
  executionGrantPolicies, executionGrants, heartbeatRuns, issueApprovals,
  issueThreadInteractions, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { executionGrantRequestHash } from "../services/execution-grant-contract.js";
import { issueExecutionGrant, withConsumedExecutionGrant } from "../services/execution-grants.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("execution grants", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-grants-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(executionGrants);
    await db.delete(executionGrantPolicies);
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentConfigRevisions);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const proposerAgentId = randomUUID();
    const stewardAgentId = randomUUID();
    const executorAgentId = randomUUID();
    const targetAgentId = randomUUID();
    const sourceRunId = randomUUID();
    const executorRunId = randomUUID();
    const decisionId = randomUUID();
    const body = { name: "Chief of staff approved name" };
    const requestHash = executionGrantRequestHash("PATCH", `/api/agents/${targetAgentId}`, body);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await db.insert(companies).values({
      id: companyId, name: "Household", issuePrefix: "JOH", defaultResponsibleUserId: "board-user",
    });
    for (const [id, name] of [
      [proposerAgentId, "Proposer"], [stewardAgentId, "Decision Steward"],
      [executorAgentId, "Executor"], [targetAgentId, "Chief of staff"],
    ]) {
      await db.insert(agents).values({
        id, companyId, name, role: "general", adapterType: "codex_local",
        adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
    }
    await db.insert(executionGrantPolicies).values({
      companyId, stewardAgentId, version: 1, updatedByUserId: "board-user",
    });
    await db.insert(heartbeatRuns).values([
      { id: sourceRunId, companyId, agentId: proposerAgentId, status: "succeeded" },
      { id: executorRunId, companyId, agentId: executorAgentId, status: "running" },
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, title: "Chief config proposal", status: "in_review",
      priority: "medium", identifier: "JOH-1", issueNumber: 1, createdByAgentId: proposerAgentId,
    });
    const payload = {
      version: 1 as const,
      prompt: "Approve this exact Chief config change?",
      detailsMarkdown: `\`\`\`diff\n- old name\n+ approved name\n\`\`\`\nRequest SHA-256: ${requestHash}`,
      executionGrant: {
        version: 1 as const, executorAgentId, targetAgentId,
        operation: "agent_config:update" as const, targetRevisionId: null,
        requestHash, expiresAt, policyVersion: 1,
      },
    };
    await db.insert(issueThreadInteractions).values({
      id: decisionId, companyId, issueId, kind: "request_confirmation", status: "accepted",
      createdByAgentId: proposerAgentId, addresseeAgentId: stewardAgentId,
      resolvedByAgentId: stewardAgentId, sourceRunId,
      payload, result: { version: 1, outcome: "accepted" },
    });
    return {
      companyId, issueId, proposerAgentId, stewardAgentId, executorAgentId,
      targetAgentId, sourceRunId, executorRunId, decisionId, requestHash, body, payload,
    };
  }

  function attempt(fixture: Awaited<ReturnType<typeof seed>>, overrides: Record<string, unknown> = {}) {
    return {
      db, grantId: "", runId: fixture.executorRunId,
      attempt: {
        companyId: fixture.companyId, executorAgentId: fixture.executorAgentId,
        targetAgentId: fixture.targetAgentId, operation: "agent_config:update" as const,
        requestHash: fixture.requestHash, ...overrides,
      },
      apply: async (txDb: typeof db) => {
        await txDb.update(agents).set({ name: fixture.body.name }).where(eq(agents.id, fixture.targetAgentId));
        return true;
      },
    };
  }

  it("applies a steward-approved Chief config change once and rejects replay, changed request and executor", async () => {
    const fixture = await seed();
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId,
      executorAgentId: fixture.executorAgentId,
    });
    expect(grant).toBeTruthy();
    const input = { ...attempt(fixture), grantId: grant!.id };
    await expect(withConsumedExecutionGrant({ ...input, attempt: { ...input.attempt, requestHash: "changed" } }))
      .rejects.toMatchObject({ status: 403, details: { code: "execution_grant_request_changed" } });
    await expect(withConsumedExecutionGrant({ ...input, attempt: { ...input.attempt, executorAgentId: randomUUID() } }))
      .rejects.toMatchObject({ status: 403, details: { code: "execution_grant_unauthorized_executor" } });
    await expect(withConsumedExecutionGrant(input)).resolves.toBe(true);
    expect((await db.select().from(agents).where(eq(agents.id, fixture.targetAgentId)))[0].name)
      .toBe(fixture.body.name);
    await expect(withConsumedExecutionGrant(input))
      .rejects.toMatchObject({ status: 403, details: { code: "execution_grant_already_consumed" } });
  });

  it("rejects self approval and any grant targeting the Steward", async () => {
    const fixture = await seed();
    await db.update(issueThreadInteractions).set({
      addresseeAgentId: fixture.proposerAgentId, resolvedByAgentId: fixture.proposerAgentId,
    }).where(eq(issueThreadInteractions.id, fixture.decisionId));
    await expect(issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId, executorAgentId: fixture.executorAgentId,
    })).rejects.toMatchObject({ status: 403 });
    await db.update(issueThreadInteractions).set({
      addresseeAgentId: fixture.stewardAgentId, resolvedByAgentId: fixture.stewardAgentId,
      payload: { ...fixture.payload, executionGrant: { ...fixture.payload.executionGrant, targetAgentId: fixture.stewardAgentId } },
    }).where(eq(issueThreadInteractions.id, fixture.decisionId));
    await expect(issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId, executorAgentId: fixture.executorAgentId,
    })).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a stale revision, expired grant, and changed policy version", async () => {
    const fixture = await seed();
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId, executorAgentId: fixture.executorAgentId,
    });
    const input = { ...attempt(fixture), grantId: grant!.id };
    await db.insert(agentConfigRevisions).values({
      companyId: fixture.companyId, agentId: fixture.targetAgentId,
      beforeConfig: {}, afterConfig: { name: "changed" },
    });
    await expect(withConsumedExecutionGrant(input))
      .rejects.toMatchObject({ status: 403, details: { code: "execution_grant_stale_target" } });
    await db.delete(agentConfigRevisions);
    await db.update(executionGrants).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(executionGrants.id, grant!.id));
    await expect(withConsumedExecutionGrant(input))
      .rejects.toMatchObject({ status: 403, details: { code: "execution_grant_expired" } });
    await db.update(executionGrants).set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(executionGrants.id, grant!.id));
    await db.update(executionGrantPolicies).set({ version: 2 })
      .where(eq(executionGrantPolicies.companyId, fixture.companyId));
    await expect(withConsumedExecutionGrant(input))
      .rejects.toMatchObject({ status: 403, details: { code: "execution_grant_policy_version_changed" } });
  });

  it("materializes a board decision into the same grant type", async () => {
    const fixture = await seed();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId: fixture.companyId, type: "request_board_approval",
      requestedByAgentId: fixture.proposerAgentId, status: "approved",
      decidedByUserId: "board-user", decidedAt: new Date(),
      payload: { detailsMarkdown: fixture.payload.detailsMarkdown, executionGrant: fixture.payload.executionGrant },
    });
    await db.insert(issueApprovals).values({ companyId: fixture.companyId, issueId: fixture.issueId, approvalId });
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "board", decisionId: approvalId, executorAgentId: fixture.executorAgentId,
    });
    expect(grant).toMatchObject({ decisionKind: "board", approverUserId: "board-user" });
  });

  it("rolls back consumption when the protected write fails", async () => {
    const fixture = await seed();
    const grant = await issueExecutionGrant({
      db, companyId: fixture.companyId, issueId: fixture.issueId,
      decisionKind: "agent", decisionId: fixture.decisionId,
      executorAgentId: fixture.executorAgentId,
    });
    const input = { ...attempt(fixture), grantId: grant!.id };
    await expect(withConsumedExecutionGrant({
      ...input,
      apply: async () => { throw new Error("write failed"); },
    })).rejects.toThrow("write failed");
    expect((await db.select().from(executionGrants).where(eq(executionGrants.id, grant!.id)))[0].consumedAt)
      .toBeNull();
    await expect(withConsumedExecutionGrant(input)).resolves.toBe(true);
  });
});
