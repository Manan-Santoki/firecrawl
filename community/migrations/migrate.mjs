#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const ledgerName = "public.schema_migrations";

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function redact(text, environment = process.env) {
  let result = String(text ?? "");
  const candidates = [
    environment.DATABASE_URL,
    environment.PGPASSWORD,
    environment.APP_POSTGRES_PASSWORD,
  ].filter(value => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    result = result.replaceAll(candidate, "[REDACTED]");
    try {
      result = result.replaceAll(decodeURIComponent(candidate), "[REDACTED]");
    } catch {
      // The value is not URI encoded.
    }
  }
  return result;
}

export function connectionEnvironment(environment = process.env) {
  const child = { ...environment };
  if (child.DATABASE_URL) {
    let parsed;
    try {
      parsed = new URL(child.DATABASE_URL);
    } catch {
      throw new Error("DATABASE_URL is not a valid PostgreSQL URL");
    }
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
      throw new Error("DATABASE_URL must use the postgres or postgresql scheme");
    }
    child.PGHOST ??= parsed.hostname;
    child.PGPORT ??= parsed.port || "5432";
    child.PGUSER ??= decodeURIComponent(parsed.username);
    child.PGPASSWORD ??= decodeURIComponent(parsed.password);
    child.PGDATABASE ??= decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    child.PGSSLMODE ??= parsed.searchParams.get("sslmode") || undefined;
    delete child.DATABASE_URL;
  }
  child.PGAPPNAME ??= "firecrawl-community-migrator";
  return child;
}

async function sha256(file) {
  // SQL line endings are not semantic, and Git may check files out as CRLF on
  // Windows. Hash the canonical LF representation so one manifest is portable
  // across operator hosts and Linux release containers.
  const canonical = (await readFile(file, "utf8")).replace(/\r\n?/g, "\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function assertExpandOnlySql(sql, file = "migration") {
  const withoutComments = String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ");
  const forbidden = [
    /\bDROP\s+(?:TABLE|SCHEMA|COLUMN|TYPE|FUNCTION|INDEX|VIEW|MATERIALIZED\s+VIEW|DATABASE)\b/i,
    /\bTRUNCATE\b/i,
    /\bALTER\s+TABLE[\s\S]{0,300}?\b(?:DROP|RENAME)\b/i,
    /\bALTER\s+TABLE[\s\S]{0,300}?\bALTER\s+COLUMN\b[\s\S]{0,120}?\bTYPE\b/i,
    /\bALTER\s+TABLE[\s\S]{0,300}?\bALTER\s+COLUMN\b[\s\S]{0,120}?\bSET\s+NOT\s+NULL\b/i,
  ];
  const match = forbidden.find(pattern => pattern.test(withoutComments));
  if (match) {
    throw new Error(`${file} violates the expand-only compatibility policy (${match})`);
  }
}

export async function loadManifest(
  manifestPath = path.join(moduleDirectory, "manifest.json"),
  { verifySourceSchema = true } = {},
) {
  const root = path.dirname(path.resolve(manifestPath));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.migrations)) {
    throw new Error("Unsupported or malformed migration manifest");
  }
  if (
    !manifest.advisoryLockName ||
    manifest.compatibilityPolicy !== "expand-only" ||
    !manifest.sourceSchema?.file ||
    !/^[a-f0-9]{64}$/.test(manifest.sourceSchema?.sha256 ?? "") ||
    manifest.migrations.length === 0
  ) {
    throw new Error("Migration manifest requires an advisory lock name, source-schema fingerprint and migrations");
  }

  if (verifySourceSchema) {
    const sourceSchemaFile = path.resolve(root, manifest.sourceSchema.file);
    const sourceSchemaChecksum = await sha256(sourceSchemaFile);
    if (sourceSchemaChecksum !== manifest.sourceSchema.sha256) {
      throw new Error(
        `API schema source changed without a reviewed migration update: expected ${manifest.sourceSchema.sha256}, got ${sourceSchemaChecksum}`,
      );
    }
  }

  const versions = new Set();
  let previousVersion = "";
  for (const migration of manifest.migrations) {
    if (!/^\d{3,}-[a-z0-9][a-z0-9-]*$/.test(migration.version)) {
      throw new Error(`Invalid migration version: ${migration.version}`);
    }
    if (versions.has(migration.version) || migration.version <= previousVersion) {
      throw new Error(`Migrations must have unique, strictly ordered versions: ${migration.version}`);
    }
    versions.add(migration.version);
    previousVersion = migration.version;
    if (typeof migration.transactional !== "boolean" || typeof migration.irreversible !== "boolean") {
      throw new Error(`Migration ${migration.version} must declare transactional and irreversible metadata`);
    }
    const absoluteFile = path.resolve(root, migration.file);
    if (!absoluteFile.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Migration file escapes the migration directory: ${migration.file}`);
    }
    const actual = await sha256(absoluteFile);
    if (actual !== migration.sha256) {
      throw new Error(`Manifest checksum does not match ${migration.file}: expected ${migration.sha256}, got ${actual}`);
    }
    const sql = (await readFile(absoluteFile, "utf8")).replace(/\r\n?/g, "\n");
    assertExpandOnlySql(sql, migration.file);
    migration.absoluteFile = absoluteFile;
    migration.sql = sql;
  }

  const postgresDirectory = path.join(root, "postgres");
  const discovered = (await readdir(postgresDirectory))
    .filter(file => /^\d{3,}-.*\.sql$/.test(file))
    .map(file => `postgres/${file}`)
    .sort();
  const declared = new Set([
    ...manifest.migrations.map(migration => migration.file),
    ...(manifest.supportFiles ?? []),
  ]);
  const undeclared = discovered.filter(file => !declared.has(file));
  const missing = [...declared].filter(file => !discovered.includes(file));
  if (undeclared.length || missing.length) {
    throw new Error(`Migration discovery mismatch; undeclared=[${undeclared.join(", ")}], missing=[${missing.join(", ")}]`);
  }
  return { ...manifest, root };
}

export function ledgerSql() {
  return `
CREATE TABLE IF NOT EXISTS ${ledgerName} (
  version text PRIMARY KEY,
  description text NOT NULL,
  checksum_sha256 char(64) NOT NULL,
  transactional boolean NOT NULL,
  irreversible boolean NOT NULL,
  baselined boolean NOT NULL DEFAULT false,
  execution_ms bigint NOT NULL CHECK (execution_ms >= 0),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
`;
}

function checksumGuardSql(migrations) {
  return migrations.map(migration => `
DO $migration_checksum$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ${ledgerName}
    WHERE version = ${sqlLiteral(migration.version)}
      AND checksum_sha256 <> ${sqlLiteral(migration.sha256)}
  ) THEN
    RAISE EXCEPTION 'checksum mismatch for applied migration ${migration.version}';
  END IF;
END
$migration_checksum$;
`).join("\n");
}

export function buildApplySql(manifest, { allowIrreversible = false } = {}) {
  const pendingBlocks = manifest.migrations.map(migration => {
    if (migration.irreversible && !allowIrreversible) {
      return `
SELECT NOT EXISTS (SELECT 1 FROM ${ledgerName} WHERE version = ${sqlLiteral(migration.version)}) AS migration_pending \\gset
\\if :migration_pending
  \\echo 'Irreversible migration ${migration.version} requires --allow-irreversible'
  \\quit 3
\\endif
`;
    }
    const begin = migration.transactional ? "BEGIN;" : "";
    const commit = migration.transactional ? "COMMIT;" : "";
    return `
SELECT EXISTS (SELECT 1 FROM ${ledgerName} WHERE version = ${sqlLiteral(migration.version)}) AS migration_applied \\gset
\\if :migration_applied
  \\echo 'already applied ${migration.version}'
\\else
  \\echo 'applying ${migration.version}'
  SELECT clock_timestamp() AS migration_started_at \\gset
  ${begin}
  ${migration.sql}
  INSERT INTO ${ledgerName} (
    version, description, checksum_sha256, transactional, irreversible, baselined, execution_ms
  ) VALUES (
    ${sqlLiteral(migration.version)},
    ${sqlLiteral(migration.description)},
    ${sqlLiteral(migration.sha256)},
    ${migration.transactional},
    ${migration.irreversible},
    false,
    GREATEST(0, floor(EXTRACT(EPOCH FROM (clock_timestamp() - :'migration_started_at'::timestamptz)) * 1000)::bigint)
  );
  ${commit}
\\endif
`;
  }).join("\n");

  return `\\set ON_ERROR_STOP on
SELECT pg_advisory_lock(hashtextextended(${sqlLiteral(manifest.advisoryLockName)}, 0));
${ledgerSql()}
${checksumGuardSql(manifest.migrations)}
${pendingBlocks}
SELECT pg_advisory_unlock(hashtextextended(${sqlLiteral(manifest.advisoryLockName)}, 0));
`;
}

export function buildBaselineSql(manifest, { through } = {}) {
  if (!through) {
    throw new Error("baseline requires an explicit --baseline-through reviewed migration boundary");
  }
  let migrations = manifest.migrations;
  const throughIndex = migrations.findIndex(migration => migration.version === through);
  if (throughIndex < 0) throw new Error(`Unknown baseline-through migration: ${through}`);
  migrations = migrations.slice(0, throughIndex + 1);
  const checks = (manifest.baselineChecks ?? []).map((check, index) => `
DO $baseline_check_${index}$
BEGIN
  IF NOT (${check}) THEN
    RAISE EXCEPTION 'existing database does not satisfy baseline check ${index + 1}';
  END IF;
END
$baseline_check_${index}$;
`).join("\n");
  const inserts = migrations.map(migration => `
INSERT INTO ${ledgerName} (
  version, description, checksum_sha256, transactional, irreversible, baselined, execution_ms
) VALUES (
  ${sqlLiteral(migration.version)}, ${sqlLiteral(migration.description)}, ${sqlLiteral(migration.sha256)},
  ${migration.transactional}, ${migration.irreversible}, true, 0
)
ON CONFLICT (version) DO NOTHING;
`).join("\n");
  return `\\set ON_ERROR_STOP on
SELECT pg_advisory_lock(hashtextextended(${sqlLiteral(manifest.advisoryLockName)}, 0));
${checks}
DO $baseline_ledger$
BEGIN
  IF to_regclass('${ledgerName}') IS NOT NULL THEN
    RAISE EXCEPTION 'baseline refuses a database that already has a migration ledger';
  END IF;
END
$baseline_ledger$;
${ledgerSql()}
${checksumGuardSql(manifest.migrations)}
BEGIN;
${inserts}
COMMIT;
SELECT pg_advisory_unlock(hashtextextended(${sqlLiteral(manifest.advisoryLockName)}, 0));
`;
}

export function migrationStatus(manifest, appliedRows) {
  const applied = new Map(appliedRows.map(row => [row.version, row]));
  return manifest.migrations.map(migration => {
    const row = applied.get(migration.version);
    return {
      version: migration.version,
      state: !row ? "pending" : row.checksum === migration.sha256 ? (row.baselined ? "baselined" : "applied") : "checksum-mismatch",
      transactional: migration.transactional,
      irreversible: migration.irreversible,
    };
  });
}

async function runPsql(sql, environment = process.env) {
  const executable = environment.PSQL_BINARY || "psql";
  const childEnvironment = connectionEnvironment(environment);
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, ["--no-psqlrc", "--set=ON_ERROR_STOP=1", "--quiet", "--tuples-only", "--no-align"], {
      env: childEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => reject(new Error(`Unable to start psql: ${error.message}`)));
    child.on("close", code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`psql exited with code ${code}: ${redact(stderr || stdout, environment).trim()}`));
    });
    child.stdin.end(sql);
  });
}

async function readAppliedRows(manifest, environment) {
  const output = await runPsql(`
SELECT CASE WHEN to_regclass('${ledgerName}') IS NULL THEN 'missing' ELSE 'present' END;
`, environment);
  if (output.trim() === "missing") return [];
  const rows = await runPsql(`
SELECT version || E'\\t' || checksum_sha256 || E'\\t' || baselined::text
FROM ${ledgerName}
ORDER BY version;
`, environment);
  return rows.trim() ? rows.trim().split(/\r?\n/).map(line => {
    const [version, checksum, baselined] = line.split("\t");
    return { version, checksum, baselined: baselined === "true" };
  }) : [];
}

async function assertFreshOrTracked(environment) {
  const { hasLedger, hasApplicationSchema } = await databaseTrackingState(environment);
  if (!hasLedger && hasApplicationSchema) {
    throw new Error("existing application schema has no migration ledger; review it, then run baseline --confirm-existing");
  }
}

async function databaseTrackingState(environment) {
  const output = await runPsql(`
SELECT concat_ws(E'\\t',
  (to_regclass('${ledgerName}') IS NOT NULL)::text,
  (to_regclass('public.api_keys') IS NOT NULL)::text
);
`, environment);
  const [hasLedger, hasApplicationSchema] = output.trim().split("\t");
  return { hasLedger: hasLedger === "true", hasApplicationSchema: hasApplicationSchema === "true" };
}

export function adoptionPlan({ hasLedger, hasApplicationSchema }) {
  return !hasLedger && hasApplicationSchema ? "baseline-then-apply" : "apply";
}

export function parseArguments(argv, environment = process.env) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "apply";
  const explicitConfirmation = args.includes("--confirm-existing");
  const environmentConfirmation = environment.COMMUNITY_MIGRATIONS_BASELINE_EXISTING === "true";
  const baselineThroughIndex = args.indexOf("--baseline-through");
  const baselineThrough = baselineThroughIndex >= 0
    ? args[baselineThroughIndex + 1]
    : environment.COMMUNITY_MIGRATIONS_BASELINE_THROUGH;
  if ((explicitConfirmation || environmentConfirmation) && !baselineThrough) {
    throw new Error(
      "baseline confirmation requires --baseline-through or COMMUNITY_MIGRATIONS_BASELINE_THROUGH to pin the reviewed adoption boundary",
    );
  }
  const options = {
    command,
    allowIrreversible: args.includes("--allow-irreversible") || environment.ALLOW_IRREVERSIBLE_MIGRATIONS === "true",
    confirmExisting: explicitConfirmation || environmentConfirmation,
    baselineThrough,
  };
  const manifestIndex = args.indexOf("--manifest");
  options.manifestPath = manifestIndex >= 0 ? args[manifestIndex + 1] : undefined;
  if (!["apply", "status", "dry-run", "baseline", "adopt"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv, environment);
  // The release image intentionally contains only the signed migration bundle.
  // CI validates the source-schema fingerprint before publishing that image.
  const manifest = await loadManifest(options.manifestPath, { verifySourceSchema: false });
  if (options.command === "status" || options.command === "dry-run") {
    const status = migrationStatus(manifest, await readAppliedRows(manifest, environment));
    console.log(JSON.stringify({ mode: options.command, migrations: status }, null, 2));
    if (status.some(item => item.state === "checksum-mismatch")) process.exitCode = 2;
    return;
  }
  if (options.command === "baseline") {
    if (!options.confirmExisting) {
      throw new Error("baseline requires --confirm-existing or COMMUNITY_MIGRATIONS_BASELINE_EXISTING=true");
    }
    await runPsql(buildBaselineSql(manifest, { through: options.baselineThrough }), environment);
    console.log("Baselined the reviewed existing-schema migrations.");
    return;
  }
  if (options.command === "adopt") {
    if (!options.baselineThrough) {
      throw new Error("adopt requires --baseline-through or COMMUNITY_MIGRATIONS_BASELINE_THROUGH");
    }
    const plan = adoptionPlan(await databaseTrackingState(environment));
    if (plan === "baseline-then-apply") {
      if (!options.confirmExisting) {
        throw new Error(
          "adopt found an untracked application schema; review it, then rerun with --confirm-existing",
        );
      }
      await runPsql(buildBaselineSql(manifest, { through: options.baselineThrough }), environment);
      console.log("Baselined the reviewed legacy schema before apply.");
    }
    await assertFreshOrTracked(environment);
    await runPsql(buildApplySql(manifest, options), environment);
    console.log(`Migration adoption complete (${manifest.migrations.length} known migrations).`);
    return;
  }
  if (options.confirmExisting) {
    await runPsql(buildBaselineSql(manifest, { through: options.baselineThrough }), environment);
    console.log("Baselined the reviewed existing-schema migrations before apply.");
  }
  await assertFreshOrTracked(environment);
  await runPsql(buildApplySql(manifest, options), environment);
  console.log(`Migration apply complete (${manifest.migrations.length} known migrations).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(redact(error.message));
    process.exitCode = 1;
  });
}
