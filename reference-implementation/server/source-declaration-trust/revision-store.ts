// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Immutable accepted declaration revisions, separate from grants and consent. */

import { createHash } from "node:crypto";

export interface AcceptedRevisionKey {
  readonly authorityBinding: string;
  readonly declarationVersion: string;
  readonly sourceId: string;
}

export interface AcceptedRevisionInput extends AcceptedRevisionKey {
  readonly parsedDeclaration: unknown;
}

export type AcceptedRevisionResult =
  | { readonly accepted: true; readonly acceptedRevisionReference: string; readonly existing: boolean }
  | { readonly accepted: false; readonly reason: "equivocation" };

export interface AcceptedRevisionLookupResult extends AcceptedRevisionKey {
  readonly acceptedRevisionReference: string;
  readonly parsedDeclaration: unknown;
}

export interface AcceptedSourceDeclarationRevisionStore {
  accept: (input: AcceptedRevisionInput) => Promise<AcceptedRevisionResult>;
  getByReference: (acceptedRevisionReference: string) => Promise<AcceptedRevisionLookupResult | null>;
}

interface StoredRevision {
  readonly accepted_revision_reference: string;
  readonly authority_binding: string;
  readonly canonical_content: string;
  readonly content_fingerprint: string;
  readonly declaration_version: string;
  readonly source_id: string;
}

interface LegacyStoredRevision {
  readonly authority_binding: string;
  readonly canonical_content: string;
  readonly content_fingerprint: string;
  readonly declaration_version: string;
  readonly source_id: string;
}

interface SqliteStatement<Row = unknown> {
  all: (...params: never[]) => Row[];
  get: (...params: never[]) => Row | undefined;
  run: (...params: never[]) => { readonly changes: number };
}

export interface SqliteRevisionDatabase {
  exec: (sql: string) => void;
  prepare: <Row = unknown>(sql: string) => SqliteStatement<Row>;
}

export interface PostgresRevisionDatabase {
  query: <Row = StoredRevision>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<{ readonly rowCount: number | null; readonly rows: readonly Row[] }>;
}

export interface RevisionStoreOptions {
  /** Test-only override; production callers use the fixed table name. */
  readonly tableName?: string;
}

const DEFAULT_TABLE = "accepted_source_declaration_revisions";
const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function tableName(options: RevisionStoreOptions): string {
  const result = options.tableName ?? DEFAULT_TABLE;
  if (!SQL_IDENTIFIER.test(result)) {
    throw new TypeError("Revision table name must be a simple lowercase SQL identifier.");
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Parsed declaration JSON must not contain non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Parsed declaration content must be JSON data.");
}

function fingerprint(canonicalContent: string): string {
  // This is only an implementation accelerator. Equality always compares the
  // stored canonical JSON after the fingerprint matches, so a hash collision
  // cannot make two parsed declarations equal.
  return createHash("sha256").update(canonicalContent).digest("hex");
}

export function acceptedRevisionEvidenceReference(input: AcceptedRevisionKey): string {
  assertKey(input);
  const stableKey = canonicalJson({
    authority_binding: input.authorityBinding,
    declaration_version: input.declarationVersion,
    source_id: input.sourceId,
  });
  return `as-local:accepted-source-declaration-revision:v1:${fingerprint(stableKey)}`;
}

function assertKey(input: AcceptedRevisionKey): void {
  for (const value of [input.authorityBinding, input.sourceId, input.declarationVersion]) {
    if (!value) {
      throw new TypeError("Accepted revision keys must be non-empty opaque strings.");
    }
  }
}

function isSameContent(stored: StoredRevision, canonicalContent: string, contentFingerprint: string): boolean {
  return stored.content_fingerprint === contentFingerprint && stored.canonical_content === canonicalContent;
}

function decodeStoredRevision(stored: StoredRevision): AcceptedRevisionLookupResult {
  const recomputedFingerprint = fingerprint(stored.canonical_content);
  if (stored.content_fingerprint !== recomputedFingerprint) {
    throw new Error("Accepted revision content fingerprint mismatch.");
  }
  const expectedReference = acceptedRevisionEvidenceReference({
    authorityBinding: stored.authority_binding,
    declarationVersion: stored.declaration_version,
    sourceId: stored.source_id,
  });
  if (stored.accepted_revision_reference !== expectedReference) {
    throw new Error("Accepted revision reference does not match stored authority binding.");
  }
  return {
    acceptedRevisionReference: stored.accepted_revision_reference,
    authorityBinding: stored.authority_binding,
    declarationVersion: stored.declaration_version,
    parsedDeclaration: JSON.parse(stored.canonical_content) as unknown,
    sourceId: stored.source_id,
  };
}

function sqliteSchema(table: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      authority_binding TEXT NOT NULL,
      source_id TEXT NOT NULL,
      declaration_version TEXT NOT NULL,
      accepted_revision_reference TEXT NOT NULL,
      canonical_content TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      UNIQUE (accepted_revision_reference),
      PRIMARY KEY (authority_binding, source_id, declaration_version)
    );`;
}

function postgresSchema(table: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      authority_binding TEXT NOT NULL,
      source_id TEXT NOT NULL,
      declaration_version TEXT NOT NULL,
      accepted_revision_reference TEXT NOT NULL,
      canonical_content TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      UNIQUE (accepted_revision_reference),
      PRIMARY KEY (authority_binding, source_id, declaration_version)
    );`;
}

function sqliteExistingTableSql(database: SqliteRevisionDatabase, table: string): string | null {
  const row = database
    .prepare<{ readonly sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(...([table] as never[]));
  return row?.sql ?? null;
}

function createSqliteRevisionTable(database: SqliteRevisionDatabase, table: string): void {
  database.exec(sqliteSchema(table));
}

function migrateSqliteRevisionTable(database: SqliteRevisionDatabase, table: string): void {
  const existingSql = sqliteExistingTableSql(database, table);
  if (!existingSql) {
    createSqliteRevisionTable(database, table);
    return;
  }
  if (
    existingSql.includes("accepted_revision_reference TEXT NOT NULL") &&
    existingSql.includes("UNIQUE (accepted_revision_reference)")
  ) {
    return;
  }

  const replacement = `${table}_migration`;
  const rows = database
    .prepare<LegacyStoredRevision>(
      `SELECT authority_binding, source_id, declaration_version, canonical_content, content_fingerprint FROM ${table}`
    )
    .all();

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`DROP TABLE IF EXISTS ${replacement}`);
    createSqliteRevisionTable(database, replacement);
    const insert = database.prepare(
      `INSERT INTO ${replacement} (authority_binding, source_id, declaration_version, accepted_revision_reference, canonical_content, content_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(
        ...([
          row.authority_binding,
          row.source_id,
          row.declaration_version,
          acceptedRevisionEvidenceReference({
            authorityBinding: row.authority_binding,
            declarationVersion: row.declaration_version,
            sourceId: row.source_id,
          }),
          row.canonical_content,
          row.content_fingerprint,
        ] as never[])
      );
    }
    database.exec(`DROP TABLE ${table}`);
    database.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function createSqliteAcceptedSourceDeclarationRevisionStore(
  database: SqliteRevisionDatabase,
  options: RevisionStoreOptions = {}
): AcceptedSourceDeclarationRevisionStore {
  const table = tableName(options);
  migrateSqliteRevisionTable(database, table);
  const insert = database.prepare(
    `INSERT INTO ${table} (authority_binding, source_id, declaration_version, accepted_revision_reference, canonical_content, content_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(authority_binding, source_id, declaration_version) DO NOTHING`
  );
  const read = database.prepare<StoredRevision>(
    `SELECT authority_binding, source_id, declaration_version, accepted_revision_reference, canonical_content, content_fingerprint FROM ${table}
     WHERE authority_binding = ? AND source_id = ? AND declaration_version = ?`
  );
  const readByReference = database.prepare<StoredRevision>(
    `SELECT authority_binding, source_id, declaration_version, accepted_revision_reference, canonical_content, content_fingerprint FROM ${table}
     WHERE accepted_revision_reference = ?`
  );
  return {
    accept(input) {
      assertKey(input);
      const canonicalContent = canonicalJson(input.parsedDeclaration);
      const contentFingerprint = fingerprint(canonicalContent);
      const acceptedRevisionReference = acceptedRevisionEvidenceReference(input);
      const inserted = insert.run(
        ...([
          input.authorityBinding,
          input.sourceId,
          input.declarationVersion,
          acceptedRevisionReference,
          canonicalContent,
          contentFingerprint,
        ] as never[])
      );
      if (inserted.changes === 1) {
        return Promise.resolve({ accepted: true, acceptedRevisionReference, existing: false } as const);
      }
      const stored = read.get(...([input.authorityBinding, input.sourceId, input.declarationVersion] as never[]));
      if (!stored) {
        throw new Error("Accepted revision disappeared after a conflicting insert.");
      }
      return Promise.resolve(
        isSameContent(stored, canonicalContent, contentFingerprint)
          ? { accepted: true, acceptedRevisionReference: stored.accepted_revision_reference, existing: true }
          : { accepted: false, reason: "equivocation" }
      );
    },
    getByReference(acceptedRevisionReference) {
      const stored = readByReference.get(...([acceptedRevisionReference] as never[]));
      return Promise.resolve().then(() => (stored ? decodeStoredRevision(stored) : null));
    },
  };
}

export async function createPostgresAcceptedSourceDeclarationRevisionStore(
  database: PostgresRevisionDatabase,
  options: RevisionStoreOptions = {}
): Promise<AcceptedSourceDeclarationRevisionStore> {
  const table = tableName(options);
  await database.query(postgresSchema(table));
  await database.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS accepted_revision_reference TEXT`);
  const missingReferences = await database.query<{
    readonly authority_binding: string;
    readonly declaration_version: string;
    readonly source_id: string;
  }>(
    `SELECT authority_binding, source_id, declaration_version FROM ${table}
     WHERE accepted_revision_reference IS NULL`
  );
  await Promise.all(
    missingReferences.rows.map((row) =>
      database.query(
        `UPDATE ${table}
         SET accepted_revision_reference = $1
         WHERE authority_binding = $2 AND source_id = $3 AND declaration_version = $4`,
        [
          acceptedRevisionEvidenceReference({
            authorityBinding: row.authority_binding,
            declarationVersion: row.declaration_version,
            sourceId: row.source_id,
          }),
          row.authority_binding,
          row.source_id,
          row.declaration_version,
        ]
      )
    )
  );
  await database.query(`ALTER TABLE ${table} ALTER COLUMN accepted_revision_reference SET NOT NULL`);
  await database.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_accepted_revision_reference_key
     ON ${table} (accepted_revision_reference)`
  );
  return {
    async accept(input) {
      assertKey(input);
      const canonicalContent = canonicalJson(input.parsedDeclaration);
      const contentFingerprint = fingerprint(canonicalContent);
      const acceptedRevisionReference = acceptedRevisionEvidenceReference(input);
      const inserted = await database.query(
        `INSERT INTO ${table} (authority_binding, source_id, declaration_version, accepted_revision_reference, canonical_content, content_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(authority_binding, source_id, declaration_version) DO NOTHING
         RETURNING accepted_revision_reference, canonical_content, content_fingerprint`,
        [
          input.authorityBinding,
          input.sourceId,
          input.declarationVersion,
          acceptedRevisionReference,
          canonicalContent,
          contentFingerprint,
        ]
      );
      if (inserted.rowCount === 1) {
        return { accepted: true, acceptedRevisionReference, existing: false };
      }
      const existing = await database.query(
        `SELECT authority_binding, source_id, declaration_version, accepted_revision_reference, canonical_content, content_fingerprint FROM ${table}
         WHERE authority_binding = $1 AND source_id = $2 AND declaration_version = $3`,
        [input.authorityBinding, input.sourceId, input.declarationVersion]
      );
      const stored = existing.rows.at(0);
      if (!stored) {
        throw new Error("Accepted revision disappeared after a conflicting insert.");
      }
      return isSameContent(stored, canonicalContent, contentFingerprint)
        ? { accepted: true, acceptedRevisionReference: stored.accepted_revision_reference, existing: true }
        : { accepted: false, reason: "equivocation" };
    },
    async getByReference(acceptedRevisionReference) {
      const existing = await database.query(
        `SELECT authority_binding, source_id, declaration_version, accepted_revision_reference, canonical_content, content_fingerprint FROM ${table}
         WHERE accepted_revision_reference = $1`,
        [acceptedRevisionReference]
      );
      const stored = existing.rows.at(0);
      return stored ? decodeStoredRevision(stored) : null;
    },
  };
}
