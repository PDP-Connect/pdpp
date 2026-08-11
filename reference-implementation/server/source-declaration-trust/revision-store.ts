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
  | { readonly accepted: true; readonly existing: boolean }
  | { readonly accepted: false; readonly reason: "equivocation" };

export interface AcceptedSourceDeclarationRevisionStore {
  accept: (input: AcceptedRevisionInput) => Promise<AcceptedRevisionResult>;
}

interface StoredRevision {
  readonly canonical_content: string;
  readonly content_fingerprint: string;
}

interface SqliteStatement {
  get: (...params: never[]) => StoredRevision | undefined;
  run: (...params: never[]) => { readonly changes: number };
}

export interface SqliteRevisionDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
}

export interface PostgresRevisionDatabase {
  query: (
    sql: string,
    params?: readonly unknown[]
  ) => Promise<{ readonly rowCount: number | null; readonly rows: readonly StoredRevision[] }>;
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

function sqliteSchema(table: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      authority_binding TEXT NOT NULL,
      source_id TEXT NOT NULL,
      declaration_version TEXT NOT NULL,
      canonical_content TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      PRIMARY KEY (authority_binding, source_id, declaration_version)
    );`;
}

function postgresSchema(table: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      authority_binding TEXT NOT NULL,
      source_id TEXT NOT NULL,
      declaration_version TEXT NOT NULL,
      canonical_content TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      PRIMARY KEY (authority_binding, source_id, declaration_version)
    );`;
}

export function createSqliteAcceptedSourceDeclarationRevisionStore(
  database: SqliteRevisionDatabase,
  options: RevisionStoreOptions = {}
): AcceptedSourceDeclarationRevisionStore {
  const table = tableName(options);
  database.exec(sqliteSchema(table));
  const insert = database.prepare(
    `INSERT INTO ${table} (authority_binding, source_id, declaration_version, canonical_content, content_fingerprint)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(authority_binding, source_id, declaration_version) DO NOTHING`
  );
  const read = database.prepare(
    `SELECT canonical_content, content_fingerprint FROM ${table}
     WHERE authority_binding = ? AND source_id = ? AND declaration_version = ?`
  );
  return {
    accept(input) {
      assertKey(input);
      const canonicalContent = canonicalJson(input.parsedDeclaration);
      const contentFingerprint = fingerprint(canonicalContent);
      const inserted = insert.run(
        ...([
          input.authorityBinding,
          input.sourceId,
          input.declarationVersion,
          canonicalContent,
          contentFingerprint,
        ] as never[])
      );
      if (inserted.changes === 1) {
        return Promise.resolve({ accepted: true, existing: false } as const);
      }
      const stored = read.get(...([input.authorityBinding, input.sourceId, input.declarationVersion] as never[]));
      if (!stored) {
        throw new Error("Accepted revision disappeared after a conflicting insert.");
      }
      return Promise.resolve(
        isSameContent(stored, canonicalContent, contentFingerprint)
          ? { accepted: true, existing: true }
          : { accepted: false, reason: "equivocation" }
      );
    },
  };
}

export async function createPostgresAcceptedSourceDeclarationRevisionStore(
  database: PostgresRevisionDatabase,
  options: RevisionStoreOptions = {}
): Promise<AcceptedSourceDeclarationRevisionStore> {
  const table = tableName(options);
  await database.query(postgresSchema(table));
  return {
    async accept(input) {
      assertKey(input);
      const canonicalContent = canonicalJson(input.parsedDeclaration);
      const contentFingerprint = fingerprint(canonicalContent);
      const inserted = await database.query(
        `INSERT INTO ${table} (authority_binding, source_id, declaration_version, canonical_content, content_fingerprint)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(authority_binding, source_id, declaration_version) DO NOTHING
         RETURNING canonical_content, content_fingerprint`,
        [input.authorityBinding, input.sourceId, input.declarationVersion, canonicalContent, contentFingerprint]
      );
      if (inserted.rowCount === 1) {
        return { accepted: true, existing: false };
      }
      const existing = await database.query(
        `SELECT canonical_content, content_fingerprint FROM ${table}
         WHERE authority_binding = $1 AND source_id = $2 AND declaration_version = $3`,
        [input.authorityBinding, input.sourceId, input.declarationVersion]
      );
      const stored = existing.rows.at(0);
      if (!stored) {
        throw new Error("Accepted revision disappeared after a conflicting insert.");
      }
      return isSameContent(stored, canonicalContent, contentFingerprint)
        ? { accepted: true, existing: true }
        : { accepted: false, reason: "equivocation" };
    },
  };
}
