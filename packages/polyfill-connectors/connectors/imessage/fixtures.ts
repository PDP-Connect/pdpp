// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Synthetic chat.db builder for iMessage connector tests. Builds a bounded,
 * schema-accurate SQLite database mirroring the reverse-engineered
 * community schema (message/handle/chat/chat_message_join/
 * chat_handle_join/attachment/message_attachment_join tables) — never a
 * copy of, or generated from, a real chat.db. No PII: all handles/text are
 * synthetic fixture data.
 */

import Database from "better-sqlite3";

export interface FixtureHandle {
  id: string;
  rowid: number;
}

export interface FixtureMessage {
  chatId: number;
  /** null simulates a chat.db row with message.date = NULL. */
  dateAppleSec: number | null;
  dateReadAppleSec?: number | null;
  guid: string;
  handleRowid: number | null;
  hasAttachments?: boolean;
  isFromMe: boolean;
  rowid: number;
  service?: string;
  text: string | null;
}

export interface FixtureAttachment {
  filename: string | null;
  messageRowid: number;
  mimeType: string | null;
  rowid: number;
  totalBytes?: number | null;
}

export interface ChatDbFixtureOptions {
  attachments?: FixtureAttachment[];
  chatIds?: number[];
  handles?: FixtureHandle[];
  /** Omit attachment/message_attachment_join tables entirely. */
  includeAttachmentTables?: boolean;
  /** Omit chat_handle_join (simulates a schema-version gap). */
  includeChatHandleJoin?: boolean;
  /** (chatId, handleRowid) membership pairs. */
  memberships?: Array<{ chatId: number; handleRowid: number }>;
  messages: FixtureMessage[];
}

function createSchema(db: Database.Database, opts: ChatDbFixtureOptions): void {
  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id TEXT
    );
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      handle_id INTEGER,
      service TEXT,
      is_from_me INTEGER,
      text TEXT,
      date INTEGER,
      date_read INTEGER,
      cache_has_attachments INTEGER
    );
    CREATE TABLE chat_message_join (
      chat_id INTEGER,
      message_id INTEGER
    );
  `);

  if (opts.includeChatHandleJoin !== false) {
    db.exec(`
      CREATE TABLE chat_handle_join (
        chat_id INTEGER,
        handle_id INTEGER
      );
    `);
  }

  if (opts.includeAttachmentTables !== false) {
    db.exec(`
      CREATE TABLE attachment (
        ROWID INTEGER PRIMARY KEY,
        filename TEXT,
        mime_type TEXT,
        total_bytes INTEGER
      );
      CREATE TABLE message_attachment_join (
        message_id INTEGER,
        attachment_id INTEGER
      );
    `);
  }
}

/**
 * Apple epoch is seconds/nanos since 2001-01-01. Fixtures use plain seconds
 * (the "older macOS" branch of the heuristic in index.ts's appleDateToIso).
 */
export function appleSecFromUnixMs(unixMs: number): number {
  const APPLE_EPOCH_SEC = 978_307_200;
  return Math.floor(unixMs / 1000) - APPLE_EPOCH_SEC;
}

function insertHandles(db: Database.Database, handles: FixtureHandle[]): void {
  const insertHandle = db.prepare("INSERT INTO handle (ROWID, id) VALUES (?, ?)");
  for (const h of handles) {
    insertHandle.run(h.rowid, h.id);
  }
}

function insertChats(db: Database.Database, chatIds: number[]): void {
  const insertChat = db.prepare("INSERT INTO chat (ROWID, guid) VALUES (?, ?)");
  for (const chatId of chatIds) {
    insertChat.run(chatId, `chat-guid-${chatId}`);
  }
}

function insertMessages(db: Database.Database, messages: FixtureMessage[]): void {
  const insertMessage = db.prepare(
    `INSERT INTO message (ROWID, guid, handle_id, service, is_from_me, text, date, date_read, cache_has_attachments)
     VALUES (@rowid, @guid, @handleRowid, @service, @isFromMe, @text, @date, @dateRead, @hasAttachments)`
  );
  const insertChatMessageJoin = db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)");
  for (const m of messages) {
    insertMessage.run({
      date: m.dateAppleSec,
      dateRead: m.dateReadAppleSec ?? null,
      guid: m.guid,
      handleRowid: m.handleRowid,
      hasAttachments: m.hasAttachments ? 1 : 0,
      isFromMe: m.isFromMe ? 1 : 0,
      rowid: m.rowid,
      service: m.service ?? "iMessage",
      text: m.text,
    });
    insertChatMessageJoin.run(m.chatId, m.rowid);
  }
}

function insertMemberships(db: Database.Database, memberships: Array<{ chatId: number; handleRowid: number }>): void {
  const insertMembership = db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)");
  for (const membership of memberships) {
    insertMembership.run(membership.chatId, membership.handleRowid);
  }
}

function insertAttachments(db: Database.Database, attachments: FixtureAttachment[]): void {
  const insertAttachment = db.prepare(
    "INSERT INTO attachment (ROWID, filename, mime_type, total_bytes) VALUES (?, ?, ?, ?)"
  );
  const insertAttachmentJoin = db.prepare(
    "INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)"
  );
  for (const a of attachments) {
    insertAttachment.run(a.rowid, a.filename, a.mimeType, a.totalBytes ?? null);
    insertAttachmentJoin.run(a.messageRowid, a.rowid);
  }
}

export function buildChatDbFixture(dbPath: string, opts: ChatDbFixtureOptions): void {
  const db = new Database(dbPath);
  try {
    createSchema(db, opts);
    insertHandles(db, opts.handles ?? []);
    insertChats(db, opts.chatIds ?? []);
    insertMessages(db, opts.messages);
    if (opts.includeChatHandleJoin !== false) {
      insertMemberships(db, opts.memberships ?? []);
    }
    if (opts.includeAttachmentTables !== false) {
      insertAttachments(db, opts.attachments ?? []);
    }
  } finally {
    db.close();
  }
}
