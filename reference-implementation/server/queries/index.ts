import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const QUERIES_DIR = dirname(fileURLToPath(import.meta.url));
const SQL_FILE_SUFFIX = ".sql";
const REQUIRED_QUERY_KEYS = new Set(["listRegisteredConnectors"]);
const CAMEL_CASE_PART_RE = /[^A-Za-z0-9]+/;
const TRAILING_SEMICOLON_RE = /;\s*$/;

export interface LoadedQuery {
  readonly file: string;
  readonly key: string;
  readonly sql: string;
}

export interface ReferenceQueryRegistry extends Readonly<Record<string, LoadedQuery>> {
  readonly listRegisteredConnectors: LoadedQuery;
}

export interface QueryDatabase {
  prepare(sql: string): unknown;
}

function toCamelCase(value: string): string {
  return value
    .split(CAMEL_CASE_PART_RE)
    .filter(Boolean)
    .map((part, index) => {
      const lower = part.toLowerCase();
      return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join("");
}

function discoverSqlFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...discoverSqlFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(SQL_FILE_SUFFIX)) {
      files.push(path);
    }
  }
  return files;
}

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(TRAILING_SEMICOLON_RE, "").trim();
}

function assertSingleStatement(sql: string, file: string): void {
  if (stripTrailingSemicolon(sql).includes(";")) {
    throw new Error(`[queries] Query artifact must contain one statement: ${file}`);
  }
}

export function loadReferenceQueries(queryDir = QUERIES_DIR): ReferenceQueryRegistry {
  const entries: Record<string, LoadedQuery> = {};
  for (const file of discoverSqlFiles(queryDir)) {
    const relativeFile = relative(queryDir, file).split(sep).join("/");
    const key = toCamelCase(relativeFile.slice(0, -SQL_FILE_SUFFIX.length));
    const sql = stripTrailingSemicolon(readFileSync(file, "utf8"));
    if (!key) {
      throw new Error(`[queries] Query artifact has no stable key: ${relativeFile}`);
    }
    if (!sql) {
      throw new Error(`[queries] Query artifact is empty: ${relativeFile}`);
    }
    assertSingleStatement(sql, relativeFile);
    if (entries[key]) {
      throw new Error(`[queries] Duplicate query key "${key}" from ${entries[key].file} and ${relativeFile}`);
    }
    entries[key] = Object.freeze({ file: relativeFile, key, sql });
  }

  for (const key of REQUIRED_QUERY_KEYS) {
    if (!entries[key]) {
      throw new Error(`[queries] Missing required query artifact: ${key}`);
    }
  }

  return Object.freeze(entries) as ReferenceQueryRegistry;
}

export function validateReferenceQueries(db: QueryDatabase, registry: ReferenceQueryRegistry = referenceQueries): void {
  for (const query of Object.values(registry)) {
    try {
      db.prepare(query.sql);
    } catch (cause) {
      throw new Error(`[queries] Failed to prepare ${query.key} (${query.file})`, { cause });
    }
  }
}

export const referenceQueries = loadReferenceQueries();
