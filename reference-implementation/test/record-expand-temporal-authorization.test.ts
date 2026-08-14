// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { ingestRecord, queryRecords } from "../server/records.ts";

test("SQLite expansion enforces the child grant's frozen time_constraint in SQL", async () => {
  const connectorId = `expand_time_${Date.now()}`;
  const parentStream = "projects";
  const childStream = "events";
  const manifest = {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: "Temporal Expand Test",
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: parentStream,
        primary_key: ["id"],
        query: { expand: [{ default_limit: 10, max_limit: 10, name: "events" }] },
        relationships: [{ cardinality: "has_many", foreign_key: "project_id", name: "events", stream: childStream }],
        schema: {
          properties: { id: { type: "string" }, name: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        consent_time_field: "event-time",
        cursor_field: "occurred_at",
        name: childStream,
        primary_key: ["id"],
        schema: {
          properties: {
            "event-time": { format: "date-time", type: "string" },
            id: { type: "string" },
            mutable_time: { format: "date-time", type: "string" },
            occurred_at: { format: "date-time", type: "string" },
            project_id: { type: "string" },
          },
          required: ["id", "project_id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };

  initDb(":memory:");
  try {
    await registerConnector(manifest);
    await ingestRecord(connectorId, {
      data: { id: "project-1", name: "One" },
      key: "project-1",
      stream: parentStream,
    });
    const events = [
      {
        "event-time": "2026-01-01T00:00:00Z",
        id: "since",
        mutable_time: "1999-01-01T00:00:00Z",
        occurred_at: "2026-01-01T00:00:00Z",
      },
      {
        "event-time": "2026-01-02T00:00:00Z",
        id: "inside",
        mutable_time: "1999-01-01T00:00:00Z",
        occurred_at: "2026-01-02T00:00:00Z",
      },
      {
        "event-time": "2026-01-03T00:00:00Z",
        id: "until",
        mutable_time: "2026-01-02T00:00:00Z",
        occurred_at: "2026-01-03T00:00:00Z",
      },
      { id: "missing", mutable_time: "2026-01-02T00:00:00Z", occurred_at: "2026-01-04T00:00:00Z" },
      {
        "event-time": "not-a-time",
        id: "malformed",
        mutable_time: "2026-01-02T00:00:00Z",
        occurred_at: "2026-01-05T00:00:00Z",
      },
    ];
    await Promise.all(
      events.map((event) =>
        ingestRecord(connectorId, {
          data: { ...event, project_id: "project-1" },
          key: event.id,
          stream: childStream,
        })
      )
    );

    const response = await queryRecords(
      connectorId,
      parentStream,
      {
        streams: [
          { fields: ["id", "name"], name: parentStream },
          {
            fields: ["event-time", "id", "project_id"],
            name: childStream,
            time_constraint: {
              field: "event-time",
              since: "2026-01-01T00:00:00Z",
              until: "2026-01-03T00:00:00Z",
            },
          },
        ],
      },
      { expand: "events" },
      manifest
    );

    const [project] = response.data as Array<{
      expanded?: { events?: { data: Array<{ id: string }> } };
    }>;
    assert.ok(project?.expanded?.events);
    assert.deepEqual(
      project.expanded.events.data.map((event: { id: string }) => event.id),
      ["since", "inside"]
    );
  } finally {
    closeDb();
  }
});
