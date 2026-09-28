import { describe, expect, it } from "vitest";
import { createIssueSchema, ISSUE_SUMMARY_LIMITS, issueSummarySchema, updateIssueSchema } from "./issue.js";

describe("issue summary", () => {
  it("accepts up to three paragraphs", () => {
    expect(issueSummarySchema.parse("One.\n\nTwo.\n\nThree.")).toBe("One.\n\nTwo.\n\nThree.");
  });

  it("rejects a fourth paragraph", () => {
    expect(issueSummarySchema.safeParse("1\n\n2\n\n3\n\n4").success).toBe(false);
  });

  it("counts escaped CLI line breaks as paragraph breaks", () => {
    expect(issueSummarySchema.safeParse("1\\n\\n2\\n\\n3\\n\\n4").success).toBe(false);
  });

  it("rejects more than the max length", () => {
    expect(issueSummarySchema.safeParse("x".repeat(ISSUE_SUMMARY_LIMITS.maxLength + 1)).success).toBe(false);
  });

  it("stores whitespace-only as null", () => {
    expect(issueSummarySchema.parse("   \n  ")).toBeNull();
  });

  it("is optional on create and update", () => {
    expect(createIssueSchema.parse({ title: "T" }).summary).toBeUndefined();
    expect(createIssueSchema.parse({ title: "T", summary: "Why." }).summary).toBe("Why.");
    expect(updateIssueSchema.parse({ summary: null }).summary).toBeNull();
  });
});
