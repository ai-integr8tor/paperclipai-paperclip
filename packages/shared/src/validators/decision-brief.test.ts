import { describe, expect, it } from "vitest";
import { DECISION_BRIEF_LIMITS, decisionBriefSchema } from "./decision-brief.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const valid = {
  version: 1,
  whatIsHappening: "Integrating the payment gateway the CTO requested in CAT-50.",
  whyStopped: "Two providers fit and the choice changes cost and delivery date.",
  whatWeNeed: "Pick Stripe (ships this week) or Adyen (needs Finance contract first).",
};

describe("decisionBriefSchema", () => {
  it("accepts the three required paragraphs", () => {
    expect(decisionBriefSchema.parse(valid)).toEqual(valid);
  });

  it("accepts recommendation and relatedWork", () => {
    const parsed = decisionBriefSchema.parse({
      ...valid,
      recommendation: "Stripe — faster, and volume is below Adyen's tier.",
      relatedWork: [{ issueId, note: "Order emails wait on this." }],
    });
    expect(parsed.relatedWork).toEqual([{ issueId, note: "Order emails wait on this." }]);
  });

  it("trims and normalizes escaped line breaks", () => {
    const parsed = decisionBriefSchema.parse({ ...valid, whyStopped: "  First.\\n\\nSecond.  " });
    expect(parsed.whyStopped).toBe("First.\n\nSecond.");
  });

  it("rejects a missing paragraph", () => {
    const { whyStopped: _omit, ...rest } = valid;
    expect(decisionBriefSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects blank paragraphs", () => {
    expect(decisionBriefSchema.safeParse({ ...valid, whatWeNeed: "   " }).success).toBe(false);
  });

  it("rejects a version other than 1", () => {
    expect(decisionBriefSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
  });

  it("enforces paragraph and recommendation limits", () => {
    const tooLong = "x".repeat(DECISION_BRIEF_LIMITS.paragraph + 1);
    expect(decisionBriefSchema.safeParse({ ...valid, whatIsHappening: tooLong }).success).toBe(false);
    const longRec = "x".repeat(DECISION_BRIEF_LIMITS.recommendation + 1);
    expect(decisionBriefSchema.safeParse({ ...valid, recommendation: longRec }).success).toBe(false);
  });

  it("caps relatedWork at 8 entries and each note at 300 chars", () => {
    const nine = Array.from({ length: 9 }, () => ({ note: "n" }));
    expect(decisionBriefSchema.safeParse({ ...valid, relatedWork: nine }).success).toBe(false);
    const longNote = [{ note: "x".repeat(DECISION_BRIEF_LIMITS.relatedWorkNote + 1) }];
    expect(decisionBriefSchema.safeParse({ ...valid, relatedWork: longNote }).success).toBe(false);
  });

  it("rejects non-uuid ids and unknown keys", () => {
    expect(decisionBriefSchema.safeParse({ ...valid, relatedWork: [{ issueId: "CAT-61", note: "n" }] }).success).toBe(false);
    expect(decisionBriefSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});
