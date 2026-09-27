import { describe, expect, it } from "vitest";
import { decisionBriefSchema } from "@paperclipai/shared";
import { buildArchiveProposalBrief } from "../services/decision-brief.js";

describe("buildArchiveProposalBrief", () => {
  it("produces a schema-valid brief with singular phrasing for one item", () => {
    const brief = buildArchiveProposalBrief(1);
    expect(() => decisionBriefSchema.parse(brief)).not.toThrow();
    expect(brief.whatIsHappening).toContain("1 aging decision");
    expect(brief.whatIsHappening).not.toContain("1 aging decisions");
  });

  it("produces a schema-valid brief with plural phrasing for multiple items", () => {
    const brief = buildArchiveProposalBrief(3);
    expect(() => decisionBriefSchema.parse(brief)).not.toThrow();
    expect(brief.whatIsHappening).toContain("3 aging decisions");
  });
});
