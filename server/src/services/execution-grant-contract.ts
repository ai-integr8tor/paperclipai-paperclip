import { createHash } from "node:crypto";

export const EXECUTION_GRANT_POLICY_VERSION = 1;

export type ExecutionGrantDecision =
  | { kind: "agent"; decisionId: string; approverAgentId: string }
  | { kind: "board"; decisionId: string; approverUserId: string };

export interface ExecutionGrant {
  companyId: string;
  issueId: string;
  proposerAgentId: string;
  executorAgentId: string;
  targetAgentId: string;
  operation: "agent_config:update";
  targetRevisionId: string | null;
  requestHash: string;
  expiresAt: Date;
  policyVersion: number;
  decision: ExecutionGrantDecision;
  consumedAt: Date | null;
}

export interface ExecutionGrantAttempt {
  companyId: string;
  executorAgentId: string;
  targetAgentId: string;
  operation: "agent_config:update";
  targetRevisionId: string | null;
  requestHash: string;
  decisionStewardAgentId: string;
  currentPolicyVersion: number;
  now: Date;
}

export type ExecutionGrantDenial =
  | "company_mismatch"
  | "self_approval"
  | "approver_is_executor"
  | "steward_powers"
  | "already_consumed"
  | "expired"
  | "policy_version_changed"
  | "unauthorized_executor"
  | "target_changed"
  | "operation_changed"
  | "stale_target"
  | "request_changed";

/** JSON canonicalization for an exact API request, excluding only the grant reference header. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function executionGrantRequestHash(method: string, path: string, body: unknown, targetUpdatedAt?: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ method: method.toUpperCase(), path, body: canonicalize(body), targetUpdatedAt }))
    .digest("hex");
}

/** This exact text is shown to the approver and checked again before issuance. */
export function executionGrantApprovalDetails(request: {
  executorAgentId: string;
  targetAgentId: string;
  targetRevisionId: string | null;
  targetUpdatedAt: string;
  requestBody: Record<string, unknown>;
  requestHash: string;
  expiresAt: string;
  policyVersion: number;
}): string {
  const bodyLines = JSON.stringify(canonicalize(request.requestBody), null, 2)
    .split("\n").map((line) => `+${line}`);
  return [
    "Approve one exact agent configuration write.",
    `Executor agent: ${request.executorAgentId}`,
    `Target agent: ${request.targetAgentId}`,
    `Target revision: ${request.targetRevisionId ?? "none"}`,
    `Target updated at: ${request.targetUpdatedAt}`,
    `Expires at: ${request.expiresAt}`,
    `Policy version: ${request.policyVersion}`,
    "",
    "```diff",
    `+++ PATCH /api/agents/${request.targetAgentId}`,
    ...bodyLines,
    "```",
    `Request SHA-256: ${request.requestHash}`,
  ].join("\n");
}

export function executionGrantDenial(
  grant: ExecutionGrant,
  attempt: ExecutionGrantAttempt,
): ExecutionGrantDenial | null {
  if (grant.companyId !== attempt.companyId) return "company_mismatch";
  if (grant.decision.kind === "agent" && grant.decision.approverAgentId === grant.proposerAgentId) {
    return "self_approval";
  }
  if (grant.decision.kind === "agent" && grant.decision.approverAgentId === grant.executorAgentId) {
    return "approver_is_executor";
  }
  if (grant.targetAgentId === attempt.decisionStewardAgentId) return "steward_powers";
  if (grant.consumedAt !== null) return "already_consumed";
  if (grant.expiresAt.getTime() <= attempt.now.getTime()) return "expired";
  if (grant.policyVersion !== attempt.currentPolicyVersion) return "policy_version_changed";
  if (grant.executorAgentId !== attempt.executorAgentId) return "unauthorized_executor";
  if (grant.targetAgentId !== attempt.targetAgentId) return "target_changed";
  if (grant.operation !== attempt.operation) return "operation_changed";
  if (grant.targetRevisionId !== attempt.targetRevisionId) return "stale_target";
  if (grant.requestHash !== attempt.requestHash) return "request_changed";
  return null;
}
