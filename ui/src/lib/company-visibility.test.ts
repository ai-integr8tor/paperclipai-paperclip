import { describe, expect, it } from "vitest";
import { isOperatorVisibleCompany } from "./company-visibility";

describe("isOperatorVisibleCompany", () => {
  it("keeps ordinary active companies visible and excludes runtime-only companies", () => {
    expect(isOperatorVisibleCompany({ status: "active", operatorVisible: true })).toBe(true);
    expect(isOperatorVisibleCompany({ status: "active", operatorVisible: false })).toBe(false);
  });

  it("keeps legacy records without the new field visible for a rolling deployment", () => {
    expect(isOperatorVisibleCompany({ status: "active" })).toBe(true);
  });
});
