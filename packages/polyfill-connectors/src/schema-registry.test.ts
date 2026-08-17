// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the enum-tolerance policy in makeValidateRecord.
 *
 * The defect this pins: GroupMe's attachment `type` enum was transcribed from
 * docs listing 4 values while the API sends 10, and every record carrying one
 * of the 6 unmodeled values was discarded on shape-check — 21,767 of them in a
 * single measured corpus. A closed enum against a third-party vocabulary is a
 * standing bet the vendor never ships a feature, so the runtime must degrade
 * instead of dropping. The three properties below (retained / verbatim /
 * visible) are what "degrade" has to mean, and the last two tests are the
 * counterweight: tolerance must not become a hole in real validation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { makeValidateRecord } from "./schema-registry.ts";

const AttachmentSchema = z.object({
  type: z.enum(["image", "file", "location", "emoji"]),
  url: z.string().nullable(),
});

const MessageSchema = z.object({
  id: z.string(),
  text: z.string().nullable(),
  attachments: z.array(AttachmentSchema),
});

const validate = makeValidateRecord({ messages: MessageSchema });

function messageWith(attachmentType: string) {
  return {
    id: "m-1",
    text: "hello",
    attachments: [{ type: attachmentType, url: null }],
  };
}

test("an unmodeled enum value RETAINS the record instead of skipping it", () => {
  const result = validate("messages", messageWith("mentions"));
  assert.equal(result.ok, true, "a record whose only defect is vocabulary drift must not be skipped");
});

test("the unrecognized enum value is preserved VERBATIM, never coerced or dropped", () => {
  const result = validate("messages", messageWith("linked_image"));
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const attachments = result.data.attachments as Array<{ type: string; url: string | null }>;
  assert.equal(attachments[0]?.type, "linked_image", "the value the vendor sent must survive intact");
  // The rest of the record survives too — this is not a stripped-down salvage.
  assert.equal(result.data.id, "m-1");
  assert.equal(result.data.text, "hello");
});

test("the drift is reported as an anomaly so it is visible, not silently tolerated", () => {
  const result = validate("messages", messageWith("poll"));
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.anomalies?.length, 1);
  const anomaly = result.anomalies?.[0];
  assert.equal(anomaly?.path, "attachments.0.type");
  assert.equal(anomaly?.value, "poll", "the diagnostic reports the actual value, for widening the schema later");
  assert.deepEqual(anomaly?.expected, ["image", "file", "location", "emoji"]);
});

test("a clean record is unaffected and carries no anomalies", () => {
  const result = validate("messages", messageWith("image"));
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.anomalies, undefined);
});

test("every one of GroupMe's 10 observed attachment types is retained", () => {
  // The measured vocabulary. Six were unmodeled by the original 4-value enum;
  // all ten must survive validation either way.
  const observed = [
    "mentions",
    "event",
    "reply",
    "image",
    "linked_image",
    "video",
    "emoji",
    "poll",
    "autokicked_member",
    "postprocessing",
  ];
  for (const type of observed) {
    assert.equal(validate("messages", messageWith(type)).ok, true, `${type} must be retained`);
  }
});

test("multiple unmodeled values across one record are each reported", () => {
  const result = validate("messages", {
    id: "m-2",
    text: null,
    attachments: [
      { type: "mentions", url: null },
      { type: "video", url: null },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(
    result.anomalies?.map((a) => a.value),
    ["mentions", "video"]
  );
});

// ─── The policy must NOT weaken real validation ─────────────────────────

test("a missing required id is STILL skipped", () => {
  const result = validate("messages", { text: "no id here", attachments: [] });
  assert.equal(result.ok, false, "a structurally malformed record must still be skipped");
});

test("a wrong-typed field is STILL skipped", () => {
  const result = validate("messages", { id: 42, text: null, attachments: [] });
  assert.equal(result.ok, false);
});

test("an enum drift COMBINED with a real fault is skipped on the fault", () => {
  // This is the case that decides whether tolerance is a hole: the record has
  // both an unmodeled enum value and a missing id. It must skip.
  const result = validate("messages", { text: null, attachments: [{ type: "mentions", url: null }] });
  assert.equal(result.ok, false, "drift must not launder a genuinely malformed record through");
  if (result.ok) {
    return;
  }
  assert.equal(
    result.issues.some((i) => i.path === "id"),
    true,
    "the reported issue is the real fault"
  );
});

test("a violated single-value literal is STILL skipped (a discriminator is not a vocabulary)", () => {
  // zod reports a literal mismatch with the same code as an enum mismatch, so
  // this pins the arity rule that separates them. A wrong literal means the
  // record is not the variant it claims to be — tolerating it would let a
  // genuinely mis-shaped record through.
  const validateTagged = makeValidateRecord({
    events: z.object({ id: z.string(), kind: z.literal("purchase") }),
  });
  const result = validateTagged("events", { id: "e-1", kind: "refund" });
  assert.equal(result.ok, false);
});

test("an unknown stream still passes through untouched", () => {
  const result = validate("streams_without_a_schema", { id: "x", anything: true });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.anomalies, undefined);
});
