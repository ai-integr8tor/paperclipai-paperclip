// @vitest-environment node
import { describe, expect, it } from "vitest";
import { subscriptionLoginAdapterType, supportsSandboxDeviceLogin } from "./AiConnectionCredentialStep";

describe("subscription sign-in routing", () => {
  it("maps each subscription provider to its login harness", () => {
    expect(subscriptionLoginAdapterType("anthropic")).toBe("claude_local");
    expect(subscriptionLoginAdapterType("openai")).toBe("codex_local");
    expect(subscriptionLoginAdapterType("xai")).toBe("grok_local");
    expect(subscriptionLoginAdapterType("meta")).toBe("muse_local");
  });

  it("offers sandbox device login for Muse only once it exists (phase 3)", () => {
    expect(supportsSandboxDeviceLogin("meta")).toBe(false);
    expect(supportsSandboxDeviceLogin("xai")).toBe(true);
    expect(supportsSandboxDeviceLogin("openai")).toBe(true);
  });
});
