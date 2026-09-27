import type { Db } from "@paperclipai/db";
import { agentConfigRevisions, agents, approvals, executionGrantPolicies, executionGrants, issueApprovals, issues, issueThreadInteractions } from "@paperclipai/db";
import { executionGrantRequestPayloadSchema } from "@paperclipai/shared";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { forbidden, notFound } from "../errors.js";
import {
  executionGrantDenial,
  type ExecutionGrant,
  type ExecutionGrantAttempt,
} from "./execution-grant-contract.js";

function toContract(row: typeof executionGrants.$inferSelect): ExecutionGrant {
  return {
    companyId: row.companyId,
    issueId: row.issueId,
    proposerAgentId: row.proposerAgentId,
    executorAgentId: row.executorAgentId,
    targetAgentId: row.targetAgentId,
    operation: row.operation as ExecutionGrant["operation"],
    targetRevisionId: row.targetRevisionId,
    requestHash: row.requestHash,
    expiresAt: row.expiresAt,
    policyVersion: row.policyVersion,
    decision: row.decisionKind === "agent"
      ? { kind: "agent", decisionId: row.decisionId, approverAgentId: row.approverAgentId ?? "" }
      : { kind: "board", decisionId: row.decisionId, approverUserId: row.approverUserId ?? "" },
    consumedAt: row.consumedAt,
  };
}

/** Materialize the immutable request that an agent or board already approved. */
export async function issueExecutionGrant(input: {
  db: Db;
  companyId: string;
  issueId: string;
  decisionKind: "agent" | "board";
  decisionId: string;
  executorAgentId: string;
}) {
  const policy = await input.db.select().from(executionGrantPolicies)
    .where(eq(executionGrantPolicies.companyId, input.companyId))
    .then((rows) => rows[0] ?? null);
  if (!policy) throw forbidden("Delegated authority policy is not configured", {
    code: "execution_grant_policy_missing",
  });
  const issue = await input.db.select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");

  let proposerAgentId: string | null = null;
  let approverAgentId: string | null = null;
  let approverUserId: string | null = null;
  let rawRequest: unknown = null;
  let displayedDetails: string | null = null;
  if (input.decisionKind === "agent") {
    const decision = await input.db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, input.decisionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.kind, "request_confirmation"),
      eq(issueThreadInteractions.status, "accepted"),
    )).then((rows) => rows[0] ?? null);
    if (!decision || (decision.result as { outcome?: string } | null)?.outcome !== "accepted") {
      throw forbidden("An accepted agent decision is required", { code: "execution_grant_decision_required" });
    }
    proposerAgentId = decision.createdByAgentId;
    approverAgentId = decision.resolvedByAgentId;
    if (!approverAgentId || decision.addresseeAgentId !== approverAgentId ||
        approverAgentId !== policy.stewardAgentId) {
      throw forbidden("The named agent approver must resolve the decision", { code: "execution_grant_approver_mismatch" });
    }
    const payload = decision.payload as Record<string, unknown>;
    rawRequest = payload.executionGrant;
    displayedDetails = typeof payload.detailsMarkdown === "string" ? payload.detailsMarkdown : null;
  } else {
    const decision = await input.db.select().from(approvals).where(and(
      eq(approvals.id, input.decisionId),
      eq(approvals.companyId, input.companyId),
      eq(approvals.type, "request_board_approval"),
      eq(approvals.status, "approved"),
    )).then((rows) => rows[0] ?? null);
    const link = await input.db.select({ issueId: issueApprovals.issueId })
      .from(issueApprovals).where(and(
        eq(issueApprovals.companyId, input.companyId),
        eq(issueApprovals.issueId, input.issueId),
        eq(issueApprovals.approvalId, input.decisionId),
      )).then((rows) => rows[0] ?? null);
    if (!decision || !link || !decision.decidedByUserId) {
      throw forbidden("An approved board decision linked to this issue is required", {
        code: "execution_grant_decision_required",
      });
    }
    proposerAgentId = decision.requestedByAgentId;
    approverUserId = decision.decidedByUserId;
    rawRequest = decision.payload.executionGrant;
    displayedDetails = typeof decision.payload.detailsMarkdown === "string"
      ? decision.payload.detailsMarkdown : null;
  }

  const request = executionGrantRequestPayloadSchema.safeParse(rawRequest);
  if (!request.success || !proposerAgentId ||
      request.data.executorAgentId !== input.executorAgentId ||
      request.data.targetAgentId === policy.stewardAgentId ||
      (input.decisionKind === "agent" &&
        (approverAgentId === proposerAgentId || approverAgentId === input.executorAgentId)) ||
      !displayedDetails?.includes(request.data.requestHash) ||
      !/```diff\b|(^|\n)[+-][^\n]+/i.test(displayedDetails) ||
      Date.parse(request.data.expiresAt) <= Date.now() ||
      request.data.policyVersion !== policy.version) {
    throw forbidden("Decision does not authorize the exact proposed execution grant", {
      code: "execution_grant_invalid_decision",
    });
  }

  const [inserted] = await input.db.insert(executionGrants).values({
    companyId: input.companyId,
    issueId: input.issueId,
    decisionKind: input.decisionKind,
    decisionId: input.decisionId,
    proposerAgentId,
    approverAgentId,
    approverUserId,
    executorAgentId: request.data.executorAgentId,
    targetAgentId: request.data.targetAgentId,
    operation: request.data.operation,
    targetRevisionId: request.data.targetRevisionId,
    requestHash: request.data.requestHash,
    expiresAt: new Date(request.data.expiresAt),
    policyVersion: request.data.policyVersion,
  }).onConflictDoNothing().returning();
  if (inserted) return inserted;
  return input.db.select().from(executionGrants).where(and(
    eq(executionGrants.companyId, input.companyId),
    eq(executionGrants.decisionKind, input.decisionKind),
    eq(executionGrants.decisionId, input.decisionId),
  )).then((rows) => rows[0] ?? null);
}

/** The callback must perform the protected write through txDb, so a failure rolls back consumption. */
export async function withConsumedExecutionGrant<T>(input: {
  db: Db;
  grantId: string;
  attempt: Omit<ExecutionGrantAttempt, "targetRevisionId" | "now" | "decisionStewardAgentId" | "currentPolicyVersion">;
  runId: string;
  apply: (txDb: Db) => Promise<T>;
}): Promise<T> {
  return input.db.transaction(async (tx) => {
    const txDb = tx as Db;
    const target = await txDb.select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.attempt.targetAgentId), eq(agents.companyId, input.attempt.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!target) throw notFound("Agent not found");

    const policy = await txDb.select().from(executionGrantPolicies)
      .where(eq(executionGrantPolicies.companyId, input.attempt.companyId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!policy) throw forbidden("Delegated authority policy is not configured", {
      code: "execution_grant_policy_missing",
    });

    const currentRevision = await txDb.select({ id: agentConfigRevisions.id })
      .from(agentConfigRevisions)
      .where(and(
        eq(agentConfigRevisions.companyId, input.attempt.companyId),
        eq(agentConfigRevisions.agentId, target.id),
      ))
      .orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id))
      .limit(1)
      .then((rows) => rows[0]?.id ?? null);
    const grant = await txDb.select()
      .from(executionGrants)
      .where(and(eq(executionGrants.id, input.grantId), eq(executionGrants.companyId, input.attempt.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!grant) throw forbidden("Execution grant is unavailable", { code: "execution_grant_unavailable" });

    const now = new Date();
    const denial = executionGrantDenial(toContract(grant), {
      ...input.attempt,
      targetRevisionId: currentRevision,
      decisionStewardAgentId: policy.stewardAgentId,
      currentPolicyVersion: policy.version,
      now,
    });
    if (denial) throw forbidden("Execution grant does not authorize this write", { code: `execution_grant_${denial}` });

    const [consumed] = await txDb.update(executionGrants)
      .set({ consumedAt: now, consumedByRunId: input.runId })
      .where(and(
        eq(executionGrants.id, input.grantId),
        eq(executionGrants.companyId, input.attempt.companyId),
        eq(executionGrants.executorAgentId, input.attempt.executorAgentId),
        eq(executionGrants.targetAgentId, input.attempt.targetAgentId),
        eq(executionGrants.operation, input.attempt.operation),
        eq(executionGrants.requestHash, input.attempt.requestHash),
        gt(executionGrants.expiresAt, now),
        isNull(executionGrants.consumedAt),
      ))
      .returning({ id: executionGrants.id });
    if (!consumed) throw forbidden("Execution grant was already consumed or expired", {
      code: "execution_grant_unavailable",
    });

    return input.apply(txDb);
  });
}
