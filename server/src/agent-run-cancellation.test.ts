import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { assertAgentRunWriteAllowed } from "./agent-run-cancellation.js";

function dbWithRun(
  run:
    | { status: string; resultJson?: Record<string, unknown> | null }
    | null,
) {
  const lock = vi.fn(async () => (run ? [run] : []));
  const where = vi.fn(() => ({ for: lock }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    db: { select } as unknown as Db,
    lock,
  };
}

describe("assertAgentRunWriteAllowed", () => {
  it("rejects an agent mutation without run attribution", async () => {
    const { db, lock } = dbWithRun(null);

    await expect(
      assertAgentRunWriteAllowed(db, "company-1", { agentId: "agent-1" }),
    ).rejects.toMatchObject({
      status: 401,
      message: "Agent run id required",
      details: { code: "agent_run_id_required" },
    });
    expect(lock).not.toHaveBeenCalled();
  });

  it("rejects a run id that is not bound to the agent and company", async () => {
    const { db } = dbWithRun(null);

    await expect(
      assertAgentRunWriteAllowed(db, "company-1", {
        agentId: "agent-1",
        runId: "run-1",
      }),
    ).rejects.toMatchObject({
      status: 401,
      message: "Agent run context is invalid",
      details: { code: "agent_run_context_invalid" },
    });
  });

  it.each([
    { status: "cancelled", resultJson: {} },
    {
      status: "running",
      resultJson: { executionCancellation: { state: "requested" } },
    },
  ])("rejects revoked write authority: %j", async (run) => {
    const { db } = dbWithRun(run);

    await expect(
      assertAgentRunWriteAllowed(db, "company-1", {
        agentId: "agent-1",
        runId: "run-1",
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: "This run was cancelled",
      details: { code: "agent_run_cancelled" },
    });
  });

  it("allows an active attributed run", async () => {
    const { db, lock } = dbWithRun({ status: "running", resultJson: {} });

    await expect(
      assertAgentRunWriteAllowed(db, "company-1", {
        agentId: "agent-1",
        runId: "run-1",
      }),
    ).resolves.toBeUndefined();
    expect(lock).toHaveBeenCalledWith("share");
  });
});
