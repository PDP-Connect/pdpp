// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the loud failure for a manual-upload binding whose import directory is
 * not on this host.
 *
 * The defect these guard against: the resolver used to hand the run an env var
 * pointing at a directory that did not exist. The connector then saw no input
 * and the run reported a bare `source_incomplete` — which reads as "the owner
 * uploaded an incomplete archive" when the truth was "this server was told to
 * read a path that is not on this disk". Two real archives (419k records) sat
 * stranded behind that misattribution.
 *
 * So the contract is specifically about LEGIBILITY, not just failure: the
 * error must carry a typed code AND name the missing path and the env var, or
 * the next operator is back to guessing.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildConnectionScopedRunEnvResolver } from "../server/connection-scoped-run-env.ts";

const MISSING_CODE = "manual_upload_import_dir_missing";

function resolverForBinding(sourceBinding: unknown) {
  return buildConnectionScopedRunEnvResolver({
    createConnectorInstanceCredentialStore: () => ({}) as never,
    createConnectorInstanceStore: () => ({ get: async () => ({ sourceBinding }) }) as never,
  });
}

const RESOLVE_ARGS = {
  connectorId: "google_maps",
  connectorInstanceId: "cin_example",
  ownerSubjectId: "sub_owner",
};

test("resolves the import-dir env var when the directory exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "muid-ok-"));
  const dir = path.join(root, "manual_upload_draft_real");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "Timeline.json"), "{}");

  const resolve = resolverForBinding({
    import_dir: dir,
    import_dir_env_var: "GOOGLE_MAPS_TIMELINE_DIR",
    kind: "manual_upload_draft",
  });

  assert.deepEqual(await resolve(RESOLVE_ARGS), { GOOGLE_MAPS_TIMELINE_DIR: dir });
});

test("a missing import directory throws a typed error naming the path and env var", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "muid-missing-"));
  const missing = path.join(root, "manual_upload_draft_ghost");

  const resolve = resolverForBinding({
    import_dir: missing,
    import_dir_env_var: "GOOGLE_MAPS_TIMELINE_DIR",
    kind: "manual_upload_draft",
  });

  await assert.rejects(
    () => resolve(RESOLVE_ARGS),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, MISSING_CODE);
      // The whole point: the operator can act on this without a debugger.
      assert.ok(err.message.includes(missing), "error must name the missing path");
      assert.ok(err.message.includes("GOOGLE_MAPS_TIMELINE_DIR"), "error must name the env var");
      assert.ok(err.message.includes("cin_example"), "error must name the connection");
      return true;
    }
  );
});

test("an import path that is a file, not a directory, also fails loudly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "muid-file-"));
  const asFile = path.join(root, "manual_upload_draft_file");
  await writeFile(asFile, "not a directory");

  const resolve = resolverForBinding({
    import_dir: asFile,
    import_dir_env_var: "WHATSAPP_EXPORT_DIR",
    kind: "manual_upload",
  });

  await assert.rejects(
    () => resolve(RESOLVE_ARGS),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, MISSING_CODE);
      assert.ok(err.message.includes("is not a directory"));
      return true;
    }
  );
});

test("a non-manual-upload binding is still a clean null, not an error", async () => {
  // The resolver composes by returning null when it does not own the
  // connection. The new guard must not turn that into a throw.
  const resolve = resolverForBinding({ kind: "browser_session" });
  assert.equal(await resolve(RESOLVE_ARGS), null);
});

test("a transplanted historical_archive envelope is not claimed by the manual-upload resolver", async () => {
  // This is the exact shape that stranded the two production archives: the
  // real binding is nested, so `isManualUploadBinding` does not match and the
  // resolver returns null. Repairing THAT is the repair tool's job, not this
  // guard's -- pinned here so a future change does not silently start
  // claiming (and half-resolving) an envelope.
  const resolve = resolverForBinding({
    kind: "historical_archive",
    original_source_binding: {
      import_dir: "/var/lib/pdpp/imports/google-maps/manual_upload_draft_stale",
      import_dir_env_var: "GOOGLE_MAPS_TIMELINE_DIR",
      kind: "manual_upload_draft",
    },
    recovery_reason: "uat_record_transfer",
  });
  assert.equal(await resolve(RESOLVE_ARGS), null);
});
