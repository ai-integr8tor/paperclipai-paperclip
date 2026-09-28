import { afterEach, describe, expect, it, vi } from "vitest";
import { ghFetch } from "../services/github-fetch.js";

function authorizationSent(fetchMock: ReturnType<typeof vi.fn>) {
  return new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization");
}

describe("ghFetch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends the server GITHUB_TOKEN to github.com API and raw hosts", async () => {
    vi.stubEnv("GITHUB_TOKEN", "tok");
    for (const url of ["https://api.github.com/repos/o/r", "https://raw.githubusercontent.com/o/r/sha/SKILL.md"]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", fetchMock);
      await ghFetch(url, { headers: { accept: "application/vnd.github+json" } });
      expect(authorizationSent(fetchMock)).toBe("Bearer tok");
      expect(new Headers(fetchMock.mock.calls[0][1].headers).get("accept")).toBe("application/vnd.github+json");
    }
  });

  it("falls back to GH_TOKEN", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "gh");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await ghFetch("https://api.github.com/repos/o/r");
    expect(authorizationSent(fetchMock)).toBe("Bearer gh");
  });

  it("does not send the token to other hosts or override a caller header", async () => {
    vi.stubEnv("GITHUB_TOKEN", "tok");
    const ghe = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", ghe);
    await ghFetch("https://ghe.example.com/api/v3/repos/o/r");
    expect(authorizationSent(ghe)).toBeNull();

    const own = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", own);
    await ghFetch("https://api.github.com/repos/o/r", { headers: { authorization: "Bearer mine" } });
    expect(authorizationSent(own)).toBe("Bearer mine");
  });

  it("stays anonymous without a token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await ghFetch("https://api.github.com/repos/o/r");
    expect(authorizationSent(fetchMock)).toBeNull();
  });
});
