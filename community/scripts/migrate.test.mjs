import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildApplySql,
  buildBaselineSql,
  assertExpandOnlySql,
  connectionEnvironment,
  loadManifest,
  migrationStatus,
  redact,
} from "../migrations/migrate.mjs";

test("the checked-in manifest discovers every numbered SQL file and verifies checksums", async () => {
  const manifest = await loadManifest();
  assert.deepEqual(manifest.migrations.map(item => item.version), [
    "010-prerequisites",
    "020-current-schema",
    "030-selfhost-constraints",
    "040-selfhost-rpcs",
  ]);
});

test("migration checksums are portable across LF and CRLF checkouts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "firecrawl-migrations-crlf-"));
  await mkdir(path.join(directory, "postgres"));
  const canonicalSql = "SELECT 1;\nSELECT 2;\n";
  await writeFile(path.join(directory, "postgres", "010-one.sql"), canonicalSql.replaceAll("\n", "\r\n"));
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    formatVersion: 1,
    compatibilityPolicy: "expand-only",
    advisoryLockName: "test",
    migrations: [{
      version: "010-one",
      description: "portable line endings",
      file: "postgres/010-one.sql",
      sha256: createHash("sha256").update(canonicalSql).digest("hex"),
      transactional: true,
      irreversible: false,
    }],
  }));
  await assert.doesNotReject(loadManifest(path.join(directory, "manifest.json")));
});

test("expand-only migrations reject destructive schema operations", () => {
  assert.doesNotThrow(() => assertExpandOnlySql("ALTER TABLE jobs ADD COLUMN state text;"));
  assert.throws(() => assertExpandOnlySql("DROP TABLE jobs;", "010-drop.sql"), /expand-only/);
  assert.throws(
    () => assertExpandOnlySql("ALTER TABLE jobs RENAME COLUMN state TO status;"),
    /expand-only/,
  );
});

test("apply SQL holds one advisory lock and wraps transactional migrations", async () => {
  const manifest = await loadManifest();
  const sql = buildApplySql(manifest);
  assert.match(sql, /pg_advisory_lock/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.schema_migrations/);
  assert.match(sql, /\\ir '.*010-prerequisites\.sql'/);
  assert.match(sql, /BEGIN;[\s\S]*010-prerequisites[\s\S]*COMMIT;/);
  assert.match(sql, /checksum mismatch for applied migration/);
});

test("irreversible pending migrations fail closed unless explicitly allowed", async () => {
  const manifest = await loadManifest();
  manifest.migrations[0].irreversible = true;
  assert.match(buildApplySql(manifest), /requires --allow-irreversible/);
  assert.doesNotMatch(buildApplySql(manifest, { allowIrreversible: true }), /requires --allow-irreversible/);
});

test("baseline validates fingerprints and records reviewed checksums", async () => {
  const manifest = await loadManifest();
  const sql = buildBaselineSql(manifest);
  assert.match(sql, /existing database does not satisfy baseline check/);
  assert.match(sql, /baselined, execution_ms/);
  assert.match(sql, /true, 0/);
});

test("baseline-through never marks later forward migrations as applied", async () => {
  const manifest = await loadManifest();
  const sql = buildBaselineSql(manifest, { through: "020-current-schema" });
  assert.match(sql, /VALUES \(\s*'010-prerequisites'/);
  assert.match(sql, /VALUES \(\s*'020-current-schema'/);
  assert.doesNotMatch(sql, /VALUES \(\s*'030-selfhost-constraints'/);
  assert.throws(() => buildBaselineSql(manifest, { through: "999-unknown" }), /Unknown baseline-through/);
});

test("status distinguishes pending, applied, baselined, and checksum mismatch", async () => {
  const manifest = await loadManifest();
  const first = manifest.migrations[0];
  const second = manifest.migrations[1];
  const third = manifest.migrations[2];
  const status = migrationStatus(manifest, [
    { version: first.version, checksum: first.sha256, baselined: false },
    { version: second.version, checksum: second.sha256, baselined: true },
    { version: third.version, checksum: "0".repeat(64), baselined: false },
  ]);
  assert.deepEqual(status.map(item => item.state), ["applied", "baselined", "checksum-mismatch", "pending"]);
});

test("manifest validation rejects checksum drift and undeclared migrations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "firecrawl-migrations-"));
  await mkdir(path.join(directory, "postgres"));
  await writeFile(path.join(directory, "postgres", "010-one.sql"), "SELECT 1;\n");
  await writeFile(path.join(directory, "postgres", "020-unlisted.sql"), "SELECT 2;\n");
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    formatVersion: 1,
    compatibilityPolicy: "expand-only",
    advisoryLockName: "test",
    migrations: [{
      version: "010-one",
      description: "test",
      file: "postgres/010-one.sql",
      sha256: "0".repeat(64),
      transactional: true,
      irreversible: false,
    }],
  }));
  await assert.rejects(loadManifest(path.join(directory, "manifest.json")), /checksum does not match/);

  const validChecksum = createHash("sha256").update("SELECT 1;\n").digest("hex");
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  manifest.migrations[0].sha256 = validChecksum;
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(loadManifest(path.join(directory, "manifest.json")), /undeclared=\[postgres\/020-unlisted\.sql\]/);
});

test("database URLs are parsed into libpq variables and secrets are redacted", () => {
  const environment = connectionEnvironment({
    DATABASE_URL: "postgresql://operator:p%40ss@example.test:5433/firecrawl?sslmode=require",
  });
  assert.equal(environment.PGHOST, "example.test");
  assert.equal(environment.PGPORT, "5433");
  assert.equal(environment.PGUSER, "operator");
  assert.equal(environment.PGPASSWORD, "p@ss");
  assert.equal(environment.PGDATABASE, "firecrawl");
  assert.equal(environment.PGSSLMODE, "require");
  assert.equal(environment.DATABASE_URL, undefined);
  assert.equal(redact("failed p@ss", { PGPASSWORD: "p@ss" }), "failed [REDACTED]");
});
