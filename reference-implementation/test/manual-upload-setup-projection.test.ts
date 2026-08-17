// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the UNTESTED manifest-shaping projection
 * `manualUploadSetupFromManifest` in `server/connection-setup-plan.ts`. It maps
 * a connector manifest's `setup.manual_or_upload` block into the normalized
 * `ManualUploadSetup` read-model the reference serves for manual/upload
 * connectors. Contracts pinned:
 *
 *   - GATE: returns null unless `setup.modality === "manual_or_upload"`;
 *   - accepted_file_names: keeps only non-blank strings;
 *   - accepted_file_extensions: cleans, lowercases, and ensures a leading "."
 *     ("JSON" -> ".json", ".CSV" -> ".csv", "  zip  " -> ".zip");
 *   - acquisition_methods: maps each entry, DROPPING any without a `label`;
 *   - `label` defaults to "Import file" when absent/blank;
 *   - validation: emitted only when `validation.kind` is present; numeric,
 *     finite `max_file_bytes` survives, else maxFileBytes is null;
 *   - validation_expectations: keeps only non-blank strings;
 *   - free-form string fields are trimmed to null when blank.
 *
 * Pure — no DB, no server, no fixtures.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { type ManualUploadSetup, manualUploadSetupFromManifest } from "../server/connection-setup-plan.ts";

function assertSetup(out: ManualUploadSetup | null): asserts out is ManualUploadSetup {
  assert.ok(out, "expected a non-null ManualUploadSetup");
}

test("manualUploadSetupFromManifest: gate returns null unless modality is manual_or_upload", () => {
  assert.equal(manualUploadSetupFromManifest(null), null, "null manifest");
  assert.equal(manualUploadSetupFromManifest({}), null, "no setup");
  assert.equal(manualUploadSetupFromManifest({ setup: { modality: "static_secret" } }), null, "wrong modality");
});

test("manualUploadSetupFromManifest: minimal manual_or_upload yields normalized defaults", () => {
  const out = manualUploadSetupFromManifest({ setup: { manual_or_upload: {}, modality: "manual_or_upload" } });
  assertSetup(out);
  assert.deepEqual(
    out,
    {
      acceptedFileExtensions: [],
      acceptedFileNames: [],
      acquisitionMethods: [],
      description: null,
      helpText: null,
      helpUrl: null,
      importDirEnvVar: null,
      label: "Import file",
      largeFileFallback: null,
      validation: null,
      validationExpectations: [],
    },
    `out: ${JSON.stringify(out)}`
  );
});

test("manualUploadSetupFromManifest: file extensions are lowercased and dot-prefixed", () => {
  const out = manualUploadSetupFromManifest({
    setup: {
      // @ts-expect-error deliberately non-string array entry (7) — proves
      // the runtime cleanString/filter path drops it even though the
      // declared param type is narrower (readonly string[]).
      manual_or_upload: { accepted_file_extensions: ["JSON", ".CSV", "  zip  ", "", 7] },
      modality: "manual_or_upload",
    },
  });
  assertSetup(out);
  assert.deepEqual(
    out.acceptedFileExtensions,
    [".json", ".csv", ".zip"],
    `extensions: ${JSON.stringify(out.acceptedFileExtensions)}`
  );
});

test("manualUploadSetupFromManifest: accepted_file_names drops blank/non-string entries", () => {
  const out = manualUploadSetupFromManifest({
    setup: {
      // @ts-expect-error deliberately non-string array entry (42) — same
      // runtime-filter guard as accepted_file_extensions above.
      manual_or_upload: { accepted_file_names: ["orders.json", "   ", 42, "export.csv"] },
      modality: "manual_or_upload",
    },
  });
  assertSetup(out);
  assert.deepEqual(
    out.acceptedFileNames,
    ["orders.json", "export.csv"],
    `names: ${JSON.stringify(out.acceptedFileNames)}`
  );
});

test("manualUploadSetupFromManifest: acquisition methods without a label are dropped; the rest are shaped", () => {
  const out = manualUploadSetupFromManifest({
    setup: {
      manual_or_upload: {
        acquisition_methods: [
          {
            detail: "Go to X",
            help_url: "https://h",
            label: "Export from settings",
            platform: "web",
            posture: "manual",
          },
          { detail: "has no label", help_url: "https://nope" },
          { label: "   " }, // blank label => dropped
        ],
      },
      modality: "manual_or_upload",
    },
  });
  assertSetup(out);
  assert.equal(out.acquisitionMethods.length, 1, `expected 1 method, got ${JSON.stringify(out.acquisitionMethods)}`);
  assert.deepEqual(out.acquisitionMethods[0], {
    detail: "Go to X",
    helpUrl: "https://h",
    label: "Export from settings",
    platform: "web",
    posture: "manual",
  });
});

test('manualUploadSetupFromManifest: label falls back to "Import file" when blank', () => {
  const blank = manualUploadSetupFromManifest({
    setup: { manual_or_upload: { label: "   " }, modality: "manual_or_upload" },
  });
  assertSetup(blank);
  assert.equal(blank.label, "Import file", "blank label => default");

  const custom = manualUploadSetupFromManifest({
    setup: { manual_or_upload: { label: "Upload your archive" }, modality: "manual_or_upload" },
  });
  assertSetup(custom);
  assert.equal(custom.label, "Upload your archive", "a real label is preserved");
});

test("manualUploadSetupFromManifest: validation emitted only with a kind; finite max_file_bytes survives", () => {
  const withValidation = manualUploadSetupFromManifest({
    setup: {
      manual_or_upload: { validation: { kind: "json_schema", max_file_bytes: 1_048_576 } },
      modality: "manual_or_upload",
    },
  });
  assertSetup(withValidation);
  assert.deepEqual(withValidation.validation, { fileBacked: false, kind: "json_schema", maxFileBytes: 1_048_576 });

  const withFileBacked = manualUploadSetupFromManifest({
    setup: {
      manual_or_upload: {
        validation: { file_backed: true, kind: "whatsapp_chat_export", max_file_bytes: 1_048_576 },
      },
      modality: "manual_or_upload",
    },
  });
  assertSetup(withFileBacked);
  assert.equal(withFileBacked.validation?.fileBacked, true, "file_backed: true survives the manifest projection");

  const noKind = manualUploadSetupFromManifest({
    setup: { manual_or_upload: { validation: { max_file_bytes: 100 } }, modality: "manual_or_upload" },
  });
  assertSetup(noKind);
  assert.equal(noKind.validation, null, "no kind => validation null");

  const nonNumericBytes = manualUploadSetupFromManifest({
    setup: {
      // @ts-expect-error deliberately non-numeric max_file_bytes — proves
      // the runtime typeof/Number.isFinite guard nulls it out even though
      // the declared param type is narrower (number | null).
      manual_or_upload: { validation: { kind: "size", max_file_bytes: "big" } },
      modality: "manual_or_upload",
    },
  });
  assertSetup(nonNumericBytes);
  assert.deepEqual(
    nonNumericBytes.validation,
    { fileBacked: false, kind: "size", maxFileBytes: null },
    "non-numeric bytes => null"
  );
});

test("manualUploadSetupFromManifest: validation_expectations keeps only non-blank strings", () => {
  const out = manualUploadSetupFromManifest({
    setup: {
      manual_or_upload: { validation_expectations: ["must be array", "", "   ", "utf-8"] },
      modality: "manual_or_upload",
    },
  });
  assertSetup(out);
  assert.deepEqual(out.validationExpectations, ["must be array", "utf-8"]);
});
