import { describe, expect, it } from "vitest";
import { companies } from "./companies.js";

describe("companies schema", () => {
  it("persists operator visibility independently from an active runtime company", () => {
    const operatorVisible = (companies as unknown as {
      operatorVisible?: { name: string; notNull: boolean; hasDefault: boolean };
    }).operatorVisible;

    expect(operatorVisible).toMatchObject({
      name: "operator_visible",
      notNull: true,
      hasDefault: true,
    });
  });
});
