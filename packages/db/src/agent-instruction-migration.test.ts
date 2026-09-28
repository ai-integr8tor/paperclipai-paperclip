import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const files = ["0285_legal_thunderbolts.sql", "0286_amusing_shiver_man.sql"];
const migrations = await Promise.all(files.map(async file => ({
  file, sql: await readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8"),
})));
// These migrations shipped in preview 14c3d810c9e05625121b3d27767aea9317b03125.
// Cloud upgrades require the existing SQL and journal rows to remain byte-identical.
const published = [
  { file: files[0]!, sqlHash: "5af82470982b273fb052c7e62c3695f56a9a7f2e6af29a6876f300f168167d11", journalHash: "00a680c4ca07980c76c03ddf58782da8168de7add5ed955b36affeaca1a2465b" },
  { file: files[1]!, sqlHash: "6400eb3bc26df081f0fb50bdd5a3b7bd45540c8148a0ea3d67564f462bf8180c", journalHash: "83f1e59908d11f3e4d43fb7b97ee6d829092a7038f8a45910f30cce15945ebe0" },
];
const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as {
  entries: Array<{ idx: number; when: number; tag: string; breakpoints: boolean }>;
};

describe("published instruction migration history", () => {
  it.each(published)("preserves the published SQL and journal hashes for $file", (entry) => {
    const migration = migrations.find(candidate => candidate.file === entry.file)!;
    const row = journal.entries.find(candidate => `${candidate.tag}.sql` === entry.file)!;
    expect(createHash("sha256").update(migration.sql).digest("hex")).toBe(entry.sqlHash);
    expect(createHash("sha256").update(JSON.stringify([row.idx, row.when, row.tag, row.breakpoints])).digest("hex"))
      .toBe(entry.journalHash);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("instruction revision migrations", () => {
  it("keeps applied migration receipts, revisions, and pending copies intact on repeated upgrades", async () => {
    const database = await startEmbeddedPostgresTestDatabase("instruction-migration-upgrade-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID();
      const runId = randomUUID(), revisionId = randomUUID();
      const bytes = Buffer.from("\uFEFF# Saved\r\nExact bytes ☃\n");
      const contentBase64 = bytes.toString("base64");
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES
        (${companyId}, 'Instructions', 'INS'), (${otherCompanyId}, 'Other', 'OTH')`;
      await sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${companyId}, 'Writer')`;
      await sql`INSERT INTO heartbeat_runs (id, company_id, agent_id) VALUES (${runId}, ${companyId}, ${agentId})`;
      await sql`INSERT INTO agent_instruction_revisions
        (id, company_id, agent_id, entry_file, content_base64, content_hash, byte_length, source, source_run_id)
        VALUES (${revisionId}, ${companyId}, ${agentId}, 'AGENTS.md', ${contentBase64}, ${contentHash}, ${bytes.length}, 'cleanup', ${runId})`;
      await sql`INSERT INTO agent_instruction_heads (company_id, agent_id, entry_file, revision_id)
        VALUES (${companyId}, ${agentId}, 'AGENTS.md', ${revisionId})`;
      await sql`INSERT INTO agent_instruction_working_copies
        (run_id, company_id, agent_id, responsible_user_id, entry_file, base_revision_id, base_hash, local_root, execution_root, location, state, candidate_base64, candidate_hash)
        VALUES (${runId}, ${companyId}, ${agentId}, 'editor', 'AGENTS.md', ${revisionId}, ${contentHash}, '/private/copy', '/private/copy', 'local', 'pending_commit', ${contentBase64}, ${contentHash})`;
      const snapshot = async () => ({
        journal: await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
        relations: await sql`SELECT oid::text, relname FROM pg_class WHERE relname IN
          ('agent_instruction_revisions', 'agent_instruction_heads', 'agent_instruction_working_copies') ORDER BY relname`,
        constraints: await sql`SELECT oid::text, conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid IN ('agent_instruction_revisions'::regclass, 'agent_instruction_heads'::regclass,
            'agent_instruction_working_copies'::regclass) ORDER BY conname`,
        revisions: await sql`SELECT * FROM agent_instruction_revisions`,
        heads: await sql`SELECT * FROM agent_instruction_heads`,
        copies: await sql`SELECT * FROM agent_instruction_working_copies`,
      });
      const before = await snapshot();
      expect(before.relations).toHaveLength(3);
      for (const entry of published) expect(before.journal.some(row => row.hash === entry.sqlHash)).toBe(true);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
        await applyPendingMigrations(database.connectionString);
        expect(await snapshot()).toEqual(before);
      }
      await expect(sql`UPDATE agent_instruction_heads SET company_id = ${otherCompanyId} WHERE revision_id = ${revisionId}`)
        .rejects.toMatchObject({ code: "23503" });
      await expect(sql`UPDATE agent_instruction_working_copies SET company_id = ${otherCompanyId} WHERE run_id = ${runId}`)
        .rejects.toMatchObject({ code: "23503" });
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
