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
