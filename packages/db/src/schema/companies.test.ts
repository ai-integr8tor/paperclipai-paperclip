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

  it("points a hidden runtime company at its operator holding", () => {
    const operatorCompanyId = (companies as unknown as {
      operatorCompanyId?: { name: string; notNull: boolean };
    }).operatorCompanyId;

    expect(operatorCompanyId).toMatchObject({ name: "operator_company_id", notNull: false });
  });
});
