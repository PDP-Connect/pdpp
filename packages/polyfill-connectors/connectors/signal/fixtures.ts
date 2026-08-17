// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixtures for the Signal connector:
 *
 *   - `buildSignalExportFixture` builds a bounded, schema-accurate SQLite
 *     database mirroring the real Signal Desktop schema this connector
 *     reads (verified directly against sigtop's Go source — see
 *     parsers.ts's module doc) — never a copy of, or generated from, a
 *     real db.sqlite. No PII: all ids/text are synthetic fixture data.
 *   - `writeMockSigtopScript` writes a small Node script that stands in
 *     for the real `sigtop` binary (pointed at via `SIGTOP_BIN` in
 *     integration.test.ts): `check-database` succeeds, `export-database
 *     <file>` copies a pre-built fixture SQLite file to `<file>` (mirroring
 *     sigtop's own real O_EXCL-target-must-not-exist behavior), and
 *     `export-attachments -i <dir>` copies pre-seeded fake attachment
 *     files into `<dir>`. This lets integration.test.ts exercise the real
 *     subprocess-spawn seam (the actual entrypoint, via
 *     `runConnectorProtocolSubprocess`) without requiring a real `sigtop`
 *     install or a real Signal account — no real sigtop binary is
 *     available in this environment, so this is the only way to prove the
 *     spawn/parse/emit wiring end-to-end.
 */

import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface FixtureMessage {
  body: string | null;
  conversationId: string;
  id: string;
  json?: string | null;
  receivedAtMs?: number | null;
  sentAt: number | null;
  sourceServiceId?: string | null;
  type?: string | null;
}

export interface FixtureConversation {
  e164?: string | null;
  groupId?: string | null;
  id: string;
  name?: string | null;
  serviceId?: string | null;
  type: "private" | "group";
}

export interface FixtureMessageAttachment {
  contentType: string | null;
  fileName: string | null;
  messageId: string;
  size: number | null;
}

export interface SignalExportFixtureOptions {
  conversations?: FixtureConversation[];
  /** Omit the `message_attachments` table entirely (simulates a pre-1360 schema). */
  includeMessageAttachmentsTable?: boolean;
  messageAttachments?: FixtureMessageAttachment[];
  messages: FixtureMessage[];
}

/**
 * Builds a SQLite file at `dbPath` mirroring the real, minimal shape of
 * Signal Desktop's `messages`/`conversations`/`message_attachments` tables
 * this connector actually queries (column names verified against sigtop's
 * signal/{message,recipient,attachment}.go — see this file's module doc).
 * This is the file `sigtop export-database` would produce; the mock sigtop
 * script (`writeMockSigtopScript`) copies it verbatim in place of a real
 * export.
 */
export function buildSignalExportFixture(dbPath: string, opts: SignalExportFixtureOptions): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        type TEXT,
        name TEXT,
        e164 TEXT,
        serviceId TEXT,
        groupId TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversationId TEXT,
        sourceServiceId TEXT,
        type TEXT,
        body TEXT,
        sent_at INTEGER,
        received_at_ms INTEGER,
        json TEXT
      );
    `);
    if (opts.includeMessageAttachmentsTable !== false) {
      db.exec(`
        CREATE TABLE message_attachments (
          messageId TEXT,
          contentType TEXT,
          path TEXT,
          fileName TEXT,
          localKey TEXT,
          size INTEGER
        );
      `);
    }

    const insertConversation = db.prepare(
      "INSERT INTO conversations (id, type, name, e164, serviceId, groupId) VALUES (@id, @type, @name, @e164, @serviceId, @groupId)"
    );
    for (const c of opts.conversations ?? []) {
      insertConversation.run({
        e164: c.e164 ?? null,
        groupId: c.groupId ?? null,
        id: c.id,
        name: c.name ?? null,
        serviceId: c.serviceId ?? null,
        type: c.type,
      });
    }

    const insertMessage = db.prepare(
      "INSERT INTO messages (id, conversationId, sourceServiceId, type, body, sent_at, received_at_ms, json) VALUES (@id, @conversationId, @sourceServiceId, @type, @body, @sentAt, @receivedAtMs, @json)"
    );
    for (const m of opts.messages) {
      insertMessage.run({
        body: m.body,
        conversationId: m.conversationId,
        id: m.id,
        json: m.json ?? null,
        receivedAtMs: m.receivedAtMs ?? null,
        sentAt: m.sentAt,
        sourceServiceId: m.sourceServiceId ?? null,
        type: m.type ?? "incoming",
      });
    }

    if (opts.includeMessageAttachmentsTable !== false) {
      const insertAttachment = db.prepare(
        "INSERT INTO message_attachments (messageId, contentType, path, fileName, localKey, size) VALUES (@messageId, @contentType, @path, @fileName, @localKey, @size)"
      );
      for (const a of opts.messageAttachments ?? []) {
        insertAttachment.run({
          contentType: a.contentType,
          fileName: a.fileName,
          localKey: "fixture-key",
          messageId: a.messageId,
          path: a.fileName,
          size: a.size,
        });
      }
    }
  } finally {
    db.close();
  }
}

export interface MockSigtopAttachmentFile {
  bytes: Buffer;
  /** Conversation subdirectory name sigtop's own export would create. */
  conversationDir: string;
  filename: string;
}

export interface MockSigtopOptions {
  attachments?: MockSigtopAttachmentFile[];
  checkDatabaseExitCode?: number;
  checkDatabaseStdout?: string;
  exportDatabaseExitCode?: number;
  fixtureDbPath: string;
}

/**
 * Writes a Node script at `scriptPath` that stands in for the real
 * `sigtop` binary. Understands exactly the three subcommands+flag shapes
 * this connector actually invokes:
 *
 *   check-database                       -> exits 0, or checkDatabaseExitCode
 *   export-database <file>                -> copies fixtureDbPath to <file>
 *                                            (fails if <file> already exists,
 *                                            matching real sigtop's O_EXCL)
 *   export-attachments -i <dir>           -> writes each configured
 *                                            attachment file under
 *                                            <dir>/<conversationDir>/<filename>
 *
 * Any other invocation exits non-zero with a message on stderr, so a test
 * asserting on an unexpected sigtop call fails loudly instead of silently
 * no-op'ing.
 */
export function writeMockSigtopScript(scriptPath: string, opts: MockSigtopOptions): void {
  const payload = {
    attachments: (opts.attachments ?? []).map((a) => ({
      bytesBase64: a.bytes.toString("base64"),
      conversationDir: a.conversationDir,
      filename: a.filename,
    })),
    checkDatabaseExitCode: opts.checkDatabaseExitCode ?? 0,
    checkDatabaseStdout: opts.checkDatabaseStdout ?? "",
    exportDatabaseExitCode: opts.exportDatabaseExitCode ?? 0,
    fixtureDbPath: opts.fixtureDbPath,
  };
  // The payload is inlined directly into the generated script's source
  // text (rather than written to a sidecar file the script re-reads at
  // spawn time) so this fixture builder never itself performs a whole-file
  // read — that pattern is exactly what
  // src/local-source-bounded-read-guard.ts's mechanical scan flags for
  // filesystem/local-DB connector directories, and this file lives in
  // exactly such a directory (connectors/signal/).
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const data = ${JSON.stringify(payload)};
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "check-database") {
  if (data.checkDatabaseStdout) {
    process.stdout.write(data.checkDatabaseStdout + "\\n");
  }
  process.exit(data.checkDatabaseExitCode);
} else if (cmd === "export-database") {
  const target = args[1];
  if (!target) {
    process.stderr.write("mock sigtop: export-database requires a target file\\n");
    process.exit(1);
  }
  if (fs.existsSync(target)) {
    process.stderr.write("mock sigtop: target already exists (O_EXCL)\\n");
    process.exit(1);
  }
  if (data.exportDatabaseExitCode !== 0) {
    process.exit(data.exportDatabaseExitCode);
  }
  fs.copyFileSync(data.fixtureDbPath, target);
  process.exit(0);
} else if (cmd === "export-attachments") {
  const dirArgIndex = args.findIndex((a, i) => i > 0 && a !== "-i" && !a.startsWith("-"));
  const dir = dirArgIndex === -1 ? "." : args[dirArgIndex];
  fs.mkdirSync(dir, { recursive: true });
  for (const att of data.attachments) {
    const convDir = path.join(dir, att.conversationDir);
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(path.join(convDir, att.filename), Buffer.from(att.bytesBase64, "base64"));
  }
  process.exit(0);
} else {
  process.stderr.write("mock sigtop: unrecognized invocation: " + args.join(" ") + "\\n");
  process.exit(1);
}
`;
  writeFileSync(scriptPath, script, "utf8");
  chmodSync(scriptPath, 0o755);
}

/** Convenience: build the fixture DB + mock script together under `dir`. */
export function setupMockSigtop(
  dir: string,
  dbOpts: SignalExportFixtureOptions,
  mockOpts: Omit<MockSigtopOptions, "fixtureDbPath"> = {}
): string {
  mkdirSync(dir, { recursive: true });
  const fixtureDbPath = join(dir, "fixture-export.sqlite");
  buildSignalExportFixture(fixtureDbPath, dbOpts);
  const scriptPath = join(dir, "mock-sigtop.cjs");
  writeMockSigtopScript(scriptPath, { ...mockOpts, fixtureDbPath });
  return scriptPath;
}

// Re-exported for tests that want to copy an existing file the way the
// mock script's export-database handler does (parity check helper).
export function copyForFixture(from: string, to: string): void {
  copyFileSync(from, to);
}
