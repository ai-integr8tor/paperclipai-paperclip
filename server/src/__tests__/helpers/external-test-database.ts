/**
 * Resolve an operator-supplied external test database URL for suites that
 * perform destructive mutations.
 *
 * An external database is used only when the operator sets both
 * `PAPERCLIP_TEST_DATABASE_URL` and `PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE=1`,
 * and the URL must name a database whose name contains "test". An unconfigured
 * or non-test target returns `null` so the suite falls back to its disposable
 * embedded Postgres; a clearly non-test target aborts before any mutation.
 */
export function resolveExternalTestDatabaseUrl(): string | null {
  const raw = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
  if (!raw) return null;
  if (process.env.PAPERCLIP_ALLOW_EXTERNAL_TEST_DATABASE !== "1") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "PAPERCLIP_TEST_DATABASE_URL must be a valid PostgreSQL connection URL",
    );
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/test/i.test(databaseName)) {
    throw new Error(
      `Refusing to run destructive tests against "${databaseName || "<empty>"}": the database name must contain "test". Point PAPERCLIP_TEST_DATABASE_URL at an isolated test database, or unset it to use embedded Postgres.`,
    );
  }
  return raw;
}
