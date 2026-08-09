// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateRecord } from "./schemas.ts";

describe("GroupMe schemas", () => {
  it("validates a valid group record", () => {
    const record = {
      id: "123456",
      name: "Test Group",
      description: "A test group",
      avatar_url: "https://example.com/avatar.jpg",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      member_count: 5,
      messages_count: 100,
    };
    const result = validateRecord("groups", record);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.data.id, "123456");
  });

  it("validates a group message with attachments", () => {
    const record = {
      id: "msg-1",
      group_id: "group-1",
      user_id: "user-1",
      name: "Alice",
      text: "Hello everyone!",
      avatar_url: "https://example.com/avatar.jpg",
      created_at: "2024-01-01T12:00:00Z",
      attachments: [
        {
          type: "image",
          url: "https://example.com/image.jpg",
          name: "photo.jpg",
        },
      ],
      like_count: 3,
      system: false,
    };
    const result = validateRecord("group_messages", record);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.data.id, "msg-1");
    assert.equal(result.ok && (result.data.attachments as unknown[]).length, 1);
  });

  it("validates a direct chat with null fields", () => {
    const record = {
      id: "chat-1",
      other_user_id: "user-2",
      other_user_name: "Bob",
      avatar_url: null,
      last_message: null,
      last_message_at: "2024-01-01T12:00:00Z",
    };
    const result = validateRecord("direct_messages", record);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.data.id, "chat-1");
  });

  it("validates a direct chat message", () => {
    const record = {
      id: "dmsg-1",
      chat_id: "chat-1",
      user_id: "user-1",
      name: "Alice",
      text: "Hey there!",
      avatar_url: "https://example.com/avatar.jpg",
      created_at: "2024-01-01T12:00:00Z",
      attachments: [],
    };
    const result = validateRecord("direct_chat_messages", record);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.data.id, "dmsg-1");
  });

  it("rejects invalid timestamp", () => {
    const record = {
      id: "123456",
      name: "Test Group",
      description: null,
      avatar_url: null,
      created_at: "not-a-date",
      updated_at: "2024-01-02T00:00:00Z",
      member_count: null,
      messages_count: null,
    };
    const result = validateRecord("groups", record);
    assert.equal(result.ok, false);
  });

  it("validates a hydrated attachments record", () => {
    const record = {
      id: "msg-1:attachment:0:abcd1234abcd1234",
      message_id: "msg-1",
      message_stream: "group_messages",
      type: "image",
      content_type: "image/jpeg",
      size_bytes: 1024,
      content_sha256: "abc123",
      hydration_status: "hydrated",
      hydration_error: null,
      blob_ref: { blob_id: "blob_1", mime_type: "image/jpeg", sha256: "abc123", size_bytes: 1024 },
    };
    const result = validateRecord("attachments", record);
    assert.equal(result.ok, true);
  });

  it("validates a failed-hydration attachments record with a null blob_ref", () => {
    const record = {
      id: "msg-1:attachment:0:abcd1234abcd1234",
      message_id: "msg-1",
      message_stream: "direct_chat_messages",
      type: "file",
      content_type: "application/octet-stream",
      size_bytes: null,
      content_sha256: null,
      hydration_status: "failed",
      hydration_error: "blob upload failed (404): Stream 'attachments' not found for connector groupme",
      blob_ref: null,
    };
    const result = validateRecord("attachments", record);
    assert.equal(result.ok, true);
  });

  it("rejects an attachments record missing the required message_id", () => {
    const record = {
      id: "msg-1:attachment:0:abcd1234abcd1234",
      message_stream: "group_messages",
      type: "image",
      content_type: "image/jpeg",
      size_bytes: null,
      content_sha256: null,
      hydration_status: "deferred",
      hydration_error: null,
      blob_ref: null,
    };
    const result = validateRecord("attachments", record);
    assert.equal(result.ok, false);
  });
});
