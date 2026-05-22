/**
 * Structural assertions for the device-exporters source card.
 *
 * Local collector source instances carry two distinct identifiers:
 *
 * - `connector_instance_id` — the durable server-side connection identity
 *   that records, schedules, and `/_ref/connectors` key on. This is the
 *   value owners can paste into `/dashboard/records/<id>`.
 * - `source_instance_id` — the device-side binding identity used by
 *   `/_ref/device-exporters/source-instances` and the ingest endpoint.
 *
 * Before this regression test the card labeled `source_instance_id` as
 * "connection", which caused 404s when owners copied that id into the
 * records URL. The card must surface `connector_instance_id` under the
 * "connection" label and offer a working link to the records detail page
 * when it is bound. The "source" id is still shown for diagnostics.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const CONNECTION_LABELS_CONNECTOR_INSTANCE =
  /connection[\s\S]{0,160}<code[\s\S]{0,80}\{source\.connector_instance_id\}/;
const SOURCE_LABEL_KEEPS_SOURCE_INSTANCE = /source[\s\S]{0,160}<code[\s\S]{0,80}\{source\.source_instance_id\}/;
const RECORDS_LINK_USES_CONNECTOR_INSTANCE =
  /\/dashboard\/records\/\$\{encodeURIComponent\(source\.connector_instance_id\)\}/;
const NOT_BOUND_BRANCH = /data-testid="source-no-connector-instance"/;
const SOURCE_CARD_DOES_NOT_LABEL_SOURCE_AS_CONNECTION =
  /connection\s*\n\s*<code[\s\S]{0,80}\{source\.source_instance_id\}/;

test("source card labels connection with connector_instance_id, not source_instance_id", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(
    src,
    CONNECTION_LABELS_CONNECTOR_INSTANCE,
    "the connection field must render source.connector_instance_id"
  );
  assert.equal(
    SOURCE_CARD_DOES_NOT_LABEL_SOURCE_AS_CONNECTION.test(src),
    false,
    "the connection field must not render source.source_instance_id (the device-side id)"
  );
});

test("source card still surfaces the device-side source_instance_id for diagnostics", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, SOURCE_LABEL_KEEPS_SOURCE_INSTANCE);
});

test("source card links to the records detail page using connector_instance_id", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RECORDS_LINK_USES_CONNECTOR_INSTANCE);
});

test("source card has an explicit not-bound branch when connector_instance_id is null", async () => {
  // Honest-by-default: a source that has not yet been bound on the
  // server must say so rather than render an empty or fake link.
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, NOT_BOUND_BRANCH);
});
