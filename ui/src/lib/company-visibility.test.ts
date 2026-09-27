import { describe, expect, it } from "vitest";
import { isOperatorVisible } from "./company-visibility";

describe("isOperatorVisible", () => {
  it("keeps ordinary active companies visible and excludes runtime-only companies", () => {
    expect(isOperatorVisible({ operatorVisible: true })).toBe(true);
    expect(isOperatorVisible({ operatorVisible: false })).toBe(false);
  });

  it("keeps legacy records without the new field visible for a rolling deployment", () => {
    expect(isOperatorVisible({})).toBe(true);
  });
});
