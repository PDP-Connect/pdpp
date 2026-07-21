import assert from "node:assert/strict";
import { test } from "node:test";
import { applyStructuredRedactionPlan, parseStructuredRedactionPlan } from "./scrubber.ts";

test("structured redaction plans replace exact free-text targets", () => {
  const plan = parseStructuredRedactionPlan({
    version: 1,
    redactions: [
      {
        text: "Alice Example",
        replacement: "[REDACTED_NAME]",
        reason: "person name in free-form note",
      },
      {
        text: "Birthday gift for Mara",
        replacement: "[REDACTED_NOTE]",
        reason: "private note",
      },
    ],
  });

  const scrubbed = applyStructuredRedactionPlan("Alice Example wrote: Birthday gift for Mara", plan);

  assert.equal(scrubbed, "[REDACTED_NAME] wrote: [REDACTED_NOTE]");
});

test("structured redaction plans fail closed when a target is missing", () => {
  const plan = parseStructuredRedactionPlan({
    version: 1,
    redactions: [
      {
        text: "Alice Example",
        replacement: "[REDACTED_NAME]",
        reason: "person name in free-form note",
      },
    ],
  });

  assert.throws(() => applyStructuredRedactionPlan("No matching text here", plan), /redaction target not found/);
});

test("structured redaction plans reject non-placeholder replacements", () => {
  assert.throws(
    () =>
      parseStructuredRedactionPlan({
        version: 1,
        redactions: [
          {
            text: "Alice Example",
            replacement: "Bob Example",
            reason: "person name",
          },
        ],
      }),
    /\[REDACTED_\*\] placeholder/
  );
});
