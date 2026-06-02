import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const IMPORTS_SUSPENSE = /import \{ Suspense \} from "react"/;
const USES_CHURN_SUSPENSE_SLOT = /versionChurnSlot=\{\s*<Suspense fallback=\{<VersionChurnFallback \/>}/;
const DEFINES_CHURN_SECTION = /async function VersionChurnSection\(\)/;
const LISTS_CONNECTOR_SUMMARIES = /listConnectorSummaries\(\)/;
const LISTS_VERSION_STATS = /listRecordVersionStats\(/;

test("records page streams version-churn diagnostics instead of blocking the connection list", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, IMPORTS_SUSPENSE);
  assert.match(src, USES_CHURN_SUSPENSE_SLOT);
  assert.match(src, DEFINES_CHURN_SECTION);

  const pageBody = src.slice(
    src.indexOf("export default async function RecordsIndexPage"),
    src.indexOf("async function VersionChurnSection")
  );
  assert.match(pageBody, LISTS_CONNECTOR_SUMMARIES);
  assert.doesNotMatch(pageBody, LISTS_VERSION_STATS);
});
