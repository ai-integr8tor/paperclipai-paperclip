import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

function cssBlock(selector: string): string {
  const start = stylesheet.indexOf(`\n${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = stylesheet.indexOf("{", start);
  const bodyEnd = stylesheet.indexOf("\n}", bodyStart);
  return stylesheet.slice(bodyStart + 1, bodyEnd);
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`^\\s*--${name}:\\s*([^;]+);`, "m"));
  expect(match, `Missing token --${name}`).not.toBeNull();
  return match![1].trim();
}

function oklchLightness(value: string): number {
  const match = value.match(/^oklch\(\s*([\d.]+)/);
  expect(match, `Expected an oklch() color, got ${value}`).not.toBeNull();
  return Number(match![1]);
}

describe("destructive theme tokens", () => {
  // Confirm buttons use `bg-destructive text-destructive-foreground`. The label
  // must stay readable on the destructive fill in both themes.
  for (const selector of [":root", ".dark"]) {
    it(`keeps destructive-foreground readable on the destructive fill in ${selector}`, () => {
      const block = cssBlock(selector);
      const fill = token(block, "destructive");
      const foreground = token(block, "destructive-foreground");

      expect(foreground).not.toBe(fill);
      expect(oklchLightness(foreground) - oklchLightness(fill)).toBeGreaterThan(0.3);
    });
  }
});
