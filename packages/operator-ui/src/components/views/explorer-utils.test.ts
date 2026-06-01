import assert from "node:assert/strict";
import test from "node:test";
import { buildBlobAffordance, buildPeekFields, exactWindowSummaryText } from "./explorer-utils.ts";

test("buildPeekFields represents ungranted metadata fields as withheld", () => {
  const fields = buildPeekFields({ id: "rec_1", summary: "sensitive note", title: "Visible title" }, [
    { name: "title", granted: true, type: "text" },
    { name: "summary", granted: false, type: "text" },
  ]);

  assert.deepEqual(
    fields.map((field) => ({ name: field.name, state: field.state, valueJson: field.valueJson })),
    [
      { name: "title", state: "visible", valueJson: "Visible title" },
      { name: "summary", state: "withheld", valueJson: null },
      { name: "id", state: "visible", valueJson: "rec_1" },
    ]
  );
});

test("buildBlobAffordance links only granted declared blob fields", () => {
  assert.deepEqual(
    buildBlobAffordance({ blob_ref: { blob_id: "blob_1", fetch_url: "/v1/blobs/blob_1" } }, [
      { name: "blob_ref", granted: true, type: "blob" },
    ]),
    { fieldName: "blob_ref", href: "/v1/blobs/blob_1", state: "available" }
  );
  assert.deepEqual(
    buildBlobAffordance({ blob_ref: { blob_id: "blob_2" } }, [{ name: "blob_ref", granted: true, type: "blob" }]),
    { fieldName: "blob_ref", href: "/v1/blobs/blob_2", state: "available" }
  );

  assert.deepEqual(
    buildBlobAffordance({ blob_ref: { blob_id: "blob_1", fetch_url: "/v1/blobs/blob_1" } }, [
      { name: "blob_ref", granted: false, type: "blob" },
    ]),
    {
      fieldName: "blob_ref",
      reason: "Blob unavailable under active projection.",
      state: "unavailable",
    }
  );

  assert.equal(buildBlobAffordance({ blob_ref: { blob_id: "blob_1" } }, [{ name: "blob_ref", granted: true }]), null);
});

test("exactWindowSummaryText is explicit about exact loaded-stream scope", () => {
  assert.equal(
    exactWindowSummaryText({
      earliestAt: "2026-01-01T00:00:00.000Z",
      latestAt: "2026-03-01T00:00:00.000Z",
      total: 12,
    }),
    "exact for loaded streams: 12 records from 2026-01-01 to 2026-03-01"
  );
});
