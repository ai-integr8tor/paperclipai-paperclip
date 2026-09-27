import { describe, expect, it } from "vitest";
import { companies } from "./companies.js";

describe("companies schema", () => {
  it("defines an operator-visibility column with a true default", () => {
    expect(companies.operatorVisible).toBeDefined();
    expect(companies.operatorVisible.default).toBe(true);
  });
});
