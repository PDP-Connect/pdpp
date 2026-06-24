/**
 * Console-side manifest→role seam (Slice 4 vocab, design.md §5.2/§5.3).
 *
 * This proves the END-TO-END console consumption of the manifest's
 * `x_pdpp_role` declaration WITHOUT any connector-specific UI code:
 *
 *   stream metadata `field_capabilities[field].role`   (server emits it from
 *     the manifest's `schema.properties[field].x_pdpp_role`)
 *     → fieldCapabilitiesFromMetadata   (captures `.role`)
 *     → declaredRolesFromCapabilities    (validates via parseFieldRole)
 *     → buildRecordPreview               (places the field into the card slot)
 *
 * The `rs-streams-field-declared-role.test.js` reference suite proves the first
 * arrow (manifest → served `field_capabilities[].role`) over the live HTTP
 * surface; this suite proves the rest of the chain in the console, so the two
 * together cover the whole manifest-authored path.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecordPreview } from "../lib/record-preview.ts";
import type { StreamMetadata } from "../lib/rs-client.ts";
import { declaredRolesFromCapabilities, fieldCapabilitiesFromMetadata } from "./explore-data-assembler.ts";

// Exactly the served shape for the bundled github `repositories` stream once its
// manifest declares `name → primary-title` and `description → secondary`. `role`
// rides on the field_capabilities entry alongside `granted`/`type`, additive.
const githubRepositoriesMetadata: StreamMetadata = {
  name: "repositories",
  object: "stream_metadata",
  field_capabilities: {
    id: { granted: true, type: "id" },
    name: { granted: true, type: "text", role: "primary-title" },
    full_name: { granted: true, type: "text" },
    description: { granted: true, type: "text", role: "secondary" },
    language: { granted: true, type: "text" },
    stargazers_count: { granted: true, type: "number" },
  },
};

const githubRepoRecord = {
  id: "1296269",
  name: "Hello-World",
  full_name: "octocat/Hello-World",
  description: "My first repository on GitHub!",
  language: "Ruby",
  stargazers_count: 80,
};

test("the github/repositories pilot renders title=name + body=description from served field_capabilities[].role, no connector code", () => {
  // 1. Capture the declared roles off the served field_capabilities.
  const capabilities = fieldCapabilitiesFromMetadata(githubRepositoriesMetadata);
  const roles = declaredRolesFromCapabilities(capabilities);
  assert.deepEqual(roles, { name: "primary-title", description: "secondary" });

  // 2. The renderer places the declared fields into the title/body slots. The
  //    `repositories` stream classifies as `titled`; the declared roles drive
  //    its slots. (The kind only chooses the layout; the SLOT VALUES come from
  //    the declaration, not from any github-specific branch.)
  const preview = buildRecordPreview("titled", githubRepoRecord, null, roles);
  assert.equal(preview?.title, "Hello-World"); // = name value, by declaration
  assert.equal(preview?.body, "My first repository on GitHub!"); // = description value
});

test("an unknown declared role degrades to the generic fallback (no crash, no guess)", () => {
  // A manifest declaring x_pdpp_role:"bogus" surfaces role:"bogus" on the served
  // capability. declaredRolesFromCapabilities drops it (parseFieldRole → null),
  // so the field carries no declared role and the record takes the honest
  // generic card — never a field-name guess (Codex constraint #2).
  const metadata: StreamMetadata = {
    name: "widgets",
    field_capabilities: {
      alpha: { granted: true, type: "text", role: "bogus" },
      bravo: { granted: true, type: "text" },
    },
  };
  const roles = declaredRolesFromCapabilities(fieldCapabilitiesFromMetadata(metadata));
  // The bogus role is dropped → no declared roles at all.
  assert.deepEqual(roles, {});

  const preview = buildRecordPreview("generic", { alpha: "one", bravo: "two" }, null, roles);
  assert.equal(preview?.kind, "generic");
  assert.equal(preview?.title, undefined);
  assert.equal(preview?.body, undefined);
  assert.deepEqual(preview?.fields, [
    { label: "Alpha", name: "alpha", value: "one" },
    { label: "Bravo", name: "bravo", value: "two" },
  ]);
});

test("a valid role alongside an unknown one keeps only the valid declaration", () => {
  const metadata: StreamMetadata = {
    name: "mixed",
    field_capabilities: {
      headline: { granted: true, type: "text", role: "primary-title" },
      junk: { granted: true, type: "text", role: "not-a-role" },
    },
  };
  const roles = declaredRolesFromCapabilities(fieldCapabilitiesFromMetadata(metadata));
  assert.deepEqual(roles, { headline: "primary-title" });
});

test("a stream with no declared roles yields the empty map → undeclared records take the generic card", () => {
  const metadata: StreamMetadata = {
    name: "plain",
    field_capabilities: {
      headline: { granted: true, type: "text" },
      note: { granted: true, type: "text" },
    },
  };
  const roles = declaredRolesFromCapabilities(fieldCapabilitiesFromMetadata(metadata));
  assert.deepEqual(roles, {});

  // Two same-type text fields, no declared role → BOTH stay in the generic
  // key/value table; neither is guessed as the title (Codex constraint #7).
  const preview = buildRecordPreview(
    "generic",
    { headline: "Quarterly update", note: "All systems nominal" },
    null,
    roles
  );
  assert.equal(preview?.kind, "generic");
  assert.equal(preview?.title, undefined);
  assert.deepEqual(preview?.fields, [
    { label: "Headline", name: "headline", value: "Quarterly update" },
    { label: "Note", name: "note", value: "All systems nominal" },
  ]);
});

test("declaredRolesFromCapabilities surfaces role only — it never reads or alters grant/type semantics", () => {
  // A withheld (granted:false) field that declares a role still contributes its
  // ROLE to the map: the role is presentation-only and orthogonal to grant. (The
  // record body itself is what gates whether the value is present; the role map
  // only says which SLOT a field would fill.)
  const metadata: StreamMetadata = {
    name: "scoped",
    field_capabilities: {
      title: { granted: false, type: "text", role: "primary-title" },
      body: { granted: true, type: "text", role: "secondary" },
    },
  };
  const roles = declaredRolesFromCapabilities(fieldCapabilitiesFromMetadata(metadata));
  assert.deepEqual(roles, { title: "primary-title", body: "secondary" });
});
