import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "@paperclipai/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createPaperclipRepoSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "adapter-utils"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"paperclip"}\n', "utf8");
  await fs.writeFile(
    path.join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

async function createCustomSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "custom", skillName), { recursive: true });
  await fs.writeFile(
    path.join(root, "custom", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

describe("codex local adapter skill injection", () => {
  const paperclipKey = "paperclipai/paperclip/paperclip";
  const createAgentKey = "paperclipai/paperclip/paperclip-create-agent";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("repairs a Codex Paperclip skill symlink that still points at another live checkout", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const oldRepo = await makeTempDir("paperclip-codex-old-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    await createPaperclipRepoSkill(currentRepo, "paperclip-create-agent");
    await createPaperclipRepoSkill(oldRepo, "paperclip");
    await fs.symlink(path.join(oldRepo, "skills", "paperclip"), path.join(skillsHome, "paperclip"));

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [
          {
            key: paperclipKey,
            runtimeName: "paperclip",
            source: path.join(currentRepo, "skills", "paperclip"),
          },
          {
            key: createAgentKey,
            runtimeName: "paperclip-create-agent",
            source: path.join(currentRepo, "skills", "paperclip-create-agent"),
          },
        ],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "paperclip"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "paperclip")),
    );
    expect(await fs.realpath(path.join(skillsHome, "paperclip-create-agent"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "paperclip-create-agent")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Repaired Codex skill "paperclip"'),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Injected Codex skill "paperclip-create-agent"'),
      }),
    );
  });

  it("preserves a custom Codex skill symlink outside Paperclip repo checkouts", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const customRoot = await makeTempDir("paperclip-codex-custom-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(customRoot);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    await createCustomSkill(customRoot, "paperclip");
    await fs.symlink(path.join(customRoot, "custom", "paperclip"), path.join(skillsHome, "paperclip"));

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: paperclipKey,
        runtimeName: "paperclip",
        source: path.join(currentRepo, "skills", "paperclip"),
      }],
    });

    expect(await fs.realpath(path.join(skillsHome, "paperclip"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "paperclip")),
    );
  });

  it("prunes broken symlinks for unavailable Paperclip repo skills before Codex starts", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const oldRepo = await makeTempDir("paperclip-codex-old-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    await createPaperclipRepoSkill(oldRepo, "agent-browser");
    const staleTarget = path.join(oldRepo, "skills", "agent-browser");
    await fs.symlink(staleTarget, path.join(skillsHome, "agent-browser"));
    await fs.rm(staleTarget, { recursive: true, force: true });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{
          key: paperclipKey,
          runtimeName: "paperclip",
          source: path.join(currentRepo, "skills", "paperclip"),
        }],
      },
    );

    await expect(fs.lstat(path.join(skillsHome, "agent-browser"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Removed stale Codex skill "agent-browser"'),
      }),
    );
  });

  it("preserves other live Paperclip skill symlinks in the shared workspace skill directory", async () => {
    const currentRepo = await makeTempDir("paperclip-codex-current-");
    const skillsHome = await makeTempDir("paperclip-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createPaperclipRepoSkill(currentRepo, "paperclip");
    await createPaperclipRepoSkill(currentRepo, "agent-browser");
    await fs.symlink(
      path.join(currentRepo, "skills", "agent-browser"),
      path.join(skillsHome, "agent-browser"),
    );

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: paperclipKey,
        runtimeName: "paperclip",
        source: path.join(currentRepo, "skills", "paperclip"),
      }],
    });

    expect((await fs.lstat(path.join(skillsHome, "paperclip"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "agent-browser"))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(skillsHome, "agent-browser"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "agent-browser")),
    );
  });

  it("links agent roles shipped in a desired skill into CODEX_HOME/agents and drops them when the skill is removed", async () => {
    const root = await makeTempDir("paperclip-codex-agent-roles-");
    cleanupDirs.add(root);
    const codexHome = path.join(root, "codex-home");
    const skillsHome = path.join(codexHome, "skills");
    await createCustomSkill(root, "design");
    const skillSource = path.join(root, "custom", "design");
    await fs.mkdir(path.join(skillSource, "agents"), { recursive: true });
    await fs.writeFile(path.join(skillSource, "agents", "design_reviewer.toml"), 'name = "design_reviewer"\n', "utf8");
    await fs.writeFile(path.join(skillSource, "agents", "openai.yaml"), "interface: {}\n", "utf8");
    await fs.mkdir(path.join(codexHome, "agents"), { recursive: true });
    await fs.writeFile(path.join(codexHome, "agents", "mine.toml"), 'name = "mine"\n', "utf8");
    const entry = { key: "company/c/design", runtimeName: "design", source: skillSource };

    await ensureCodexSkillsInjected(async () => {}, { skillsHome, skillsEntries: [entry], desiredSkillNames: [entry.key] });

    const role = path.join(codexHome, "agents", "design_reviewer.toml");
    expect(await fs.readlink(role)).toBe(path.join(skillSource, "agents", "design_reviewer.toml"));
    expect((await fs.readdir(path.join(codexHome, "agents"))).sort()).toEqual(["design_reviewer.toml", "mine.toml"]);

    await ensureCodexSkillsInjected(async () => {}, { skillsHome, skillsEntries: [entry], desiredSkillNames: [] });

    expect(await fs.readdir(path.join(codexHome, "agents"))).toEqual(["mine.toml"]);
  });
});
