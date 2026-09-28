import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { evaluateIssue, type RoutingDecision, type RoutingDecisionClient } from "../src/routing.js";

const COMPANY_ID = "company-1";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: COMPANY_ID,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Checkout button fails after adding a bundle",
    description: "Reproduce and fix the WooCommerce checkout defect.",
    status: "todo",
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    responsibleUserId: "user-1",
    issueNumber: 1,
    identifier: "OCC-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-09-28T00:00:00Z"),
    updatedAt: new Date("2026-09-28T00:00:00Z"),
    ...overrides,
  };
}

function decision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    model: "jev-1.13.0",
    department: {
      type: "choice",
      choice: "engineering",
      confidence: 0.91,
      probabilities: { engineering: 0.91, needs_triage: 0.05, revenue: 0.04 },
    },
    sufficiency: { type: "noul", noul: 0.89 },
    usage: { input_tokens: 420, output_tokens: 60 },
    ...overrides,
  };
}

function setup(clientResult: RoutingDecision | Error, config: Record<string, unknown> = { enabled: true }) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ issues: [issue()] });
  const decide = vi.fn(async () => {
    if (clientResult instanceof Error) throw clientResult;
    return clientResult;
  });
  return { harness, client: { decide } satisfies RoutingDecisionClient, decide };
}

async function records(harness: ReturnType<typeof createTestHarness>) {
  return harness.ctx.entities.list({ entityType: "typesafe-routing-recommendation", scopeKind: "issue", scopeId: "issue-1" });
}

describe("TypeSafe task routing pilot", () => {
  it("records a valid recommendation without assigning the issue", async () => {
    const { harness, client } = setup(decision());
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("engineering");
    const [record] = await records(harness);
    expect(record?.data).toMatchObject({ effectiveDecision: "engineering", recommendedAgentId: "4a67e582-657f-443c-ac6d-547ae6d62325", returnedModelVersion: "jev-1.13.0", usage: { inputTokens: 420, outputTokens: 60 } });
    expect((await harness.ctx.issues.get("issue-1", COMPANY_ID))?.assigneeAgentId).toBeNull();
  });

  it("sends ambiguous probabilities to needs_triage", async () => {
    const { harness, client } = setup(decision({ department: { type: "choice", choice: "engineering", confidence: 0.76, probabilities: { engineering: 0.44, revenue: 0.40, needs_triage: 0.16 } } }));
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("needs_triage");
    expect((await records(harness))[0]?.data.reason).toBe("ambiguous");
  });

  it("maps an unknown destination to needs_triage", async () => {
    const { harness, client } = setup(decision({ department: { type: "choice", choice: "made_up", confidence: 0.95, probabilities: { made_up: 0.95, needs_triage: 0.05 } } }));
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("needs_triage");
    expect((await records(harness))[0]?.data.reason).toBe("unknown_destination");
  });

  it("fails open and records sanitized failure metadata", async () => {
    const { harness, client } = setup(new Error("provider unavailable"));
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("failed_open");
    const [record] = await records(harness);
    expect(record?.data).toMatchObject({ status: "failed", reason: "Error", effectiveDecision: null, usage: null });
    expect(JSON.stringify(record?.data)).not.toContain("provider unavailable");
  });

  it("fails open on a provider timeout", async () => {
    const timeout = new Error("request exceeded deadline");
    timeout.name = "TimeoutError";
    const { harness, client } = setup(timeout);
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("failed_open");
    expect((await records(harness))[0]?.data).toMatchObject({ status: "failed", reason: "TimeoutError", usage: null });
  });

  it("deduplicates repeated events for the same input revision", async () => {
    const { harness, client, decide } = setup(decision());
    await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client);
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("duplicate");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(await records(harness)).toHaveLength(1);
  });

  it("preserves explicit assignments without calling TypeSafe", async () => {
    const { harness, client, decide } = setup(decision());
    harness.seed({ issues: [issue({ assigneeAgentId: "already-assigned" })] });
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("explicit_assignment");
    expect(decide).not.toHaveBeenCalled();
    expect(await records(harness)).toHaveLength(0);
  });

  it("defaults disabled and makes no request", async () => {
    const { harness, client, decide } = setup(decision(), {});
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("disabled");
    expect(decide).not.toHaveBeenCalled();
  });

  it("evaluates a changed input revision once and stores a second audit record", async () => {
    const { harness, client, decide } = setup(decision());
    await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client);
    harness.seed({ issues: [issue({ description: "The checkout defect now affects mobile only.", updatedAt: new Date("2026-09-28T01:00:00Z") })] });
    await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(await records(harness)).toHaveLength(2);
  });
});
