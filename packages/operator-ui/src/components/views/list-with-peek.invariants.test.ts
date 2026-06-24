import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const VIEW_FILE = `${HERE}list-with-peek.tsx`;

const PAGE_COUNT_BASIS =
  /const pageCount = result\.data\.length;[\s\S]*const countBasis = result\.has_more[\s\S]*`\$\{pageCount\.toLocaleString\(\)\} on this page`[\s\S]*`\$\{pageCount\.toLocaleString\(\)\} shown`/;
const HEADER_USES_COUNT_BASIS = /<PageHeader[\s\S]*count=\{countBasis\}[\s\S]*\/>/;
const OLD_TOTAL_LOOKING_PLUS_COUNT = /count=\{?`\$\{result\.data\.length\}\$\{result\.has_more \? "\+" : ""\}`\}?/;
const PAGER_FOR_INCOMPLETE_PAGE =
  /result\.has_more && result\.next_cursor[\s\S]*<Pager next=\{buildListHref\(\{ cursor: result\.next_cursor \}\)\} \/>/;
const SUBJECT_LABEL_SEAM =
  /subjectLabel\?: string;[\s\S]*const subjectLabel = params\.subjectLabel \?\? subject;[\s\S]*title=\{`\$\{subjectLabel\} \$\{peekId\}`\}/;

test("paginated list header labels page counts instead of presenting bounded rows as totals", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.match(src, PAGE_COUNT_BASIS);
  assert.match(src, HEADER_USES_COUNT_BASIS);
  assert.doesNotMatch(src, OLD_TOTAL_LOOKING_PLUS_COUNT);
  assert.match(src, PAGER_FOR_INCOMPLETE_PAGE);
});

test("timeline route subject can keep protocol routing while owner copy uses a display label", async () => {
  const src = await readFile(VIEW_FILE, "utf8");

  assert.match(src, SUBJECT_LABEL_SEAM);
});
