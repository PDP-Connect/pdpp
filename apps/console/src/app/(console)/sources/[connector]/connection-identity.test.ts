/**
 * Source-text invariants for the connector detail page's identity line.
 *
 * `page.tsx` is a server component with no JSX render harness in this app, so
 * we assert the structural properties by reading the source — the same
 * strategy used by `records-list-view.test.ts` and `connector-row.test.ts`.
 *
 * The connection's stable, non-secret `connection_id` is the records-route key
 * and the selector an owner pastes into the owner-agent control surface. It was
 * already disclosed as plain `<code>`, but copying it meant a fiddly manual
 * text selection. The identity line must now pair it with a one-gesture
 * CopyButton — without turning the registry-URL fallback into a display name
 * (that rule lives in `connector-display` and is unchanged here).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const IMPORTS_COPY_BUTTON = /import \{ CopyButton \} from "@pdpp\/operator-ui\/components\/copy-button"/;
const IDENTITY_DISCLOSURE_WRAPPER = /data-testid="connection-id-disclosure"/;
const CONNECTION_ID_CODE = /<code className="font-mono text-xs">\{connectionId\}<\/code>/;
const CONNECTION_ID_COPY_BUTTON = /<CopyButton ariaLabel="Copy connection ID" value=\{connectionId\} \/>/;

test("detail page imports the CopyButton primitive", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, IMPORTS_COPY_BUTTON);
});

test("identity line still renders the stable connection_id as monospace code", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CONNECTION_ID_CODE);
});

test("identity line pairs the connection_id with a one-gesture copy affordance", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, IDENTITY_DISCLOSURE_WRAPPER);
  assert.match(src, CONNECTION_ID_COPY_BUTTON);
});
