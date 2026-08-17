#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Apple Photos Connector (v0.1.0)
 *
 * Auth: none (file-based). User goes to Photos.app on macOS, selects
 * photos/an album, then File → Export → Export Unmodified Originals (or
 * exports individual items the same way), and points the export at
 * APPLE_PHOTOS_EXPORT_DIR (defaults ~/.pdpp/imports/apple_photos/). Unlike
 * Apple Health, Photos.app's manual export does not produce a single
 * structured manifest (no export.xml-equivalent) — it just drops image and
 * video files into the target folder. This connector therefore treats the
 * export directory as a flat/recursive tree of media files and derives the
 * `photos` stream from file-level metadata: filename, size, a sha256
 * content hash, a MIME type guessed from the extension, and the file's
 * mtime as a best-effort "when did this change" timestamp. Directory
 * listing streams entries one at a time rather than loading the whole tree
 * into memory.
 *
 * WHY NOT PhotoKit: Apple's official framework for reading the photo
 * library requires a signed macOS app bundle with the
 * NSPhotoLibraryUsageDescription Info.plist key and photo-library
 * entitlement, granted through the OS permission UI. It is not reachable
 * from a bare Node/Python CLI process — there is no supported way to link
 * PhotoKit from outside a signed app bundle. That path is structurally
 * unavailable to this connector, not merely inconvenient.
 *
 * DOCUMENTED BUT NOT IMPLEMENTED — reverse-engineered Photos.sqlite path:
 * macOS Photos also keeps a SQLite database at
 * `~/Pictures/Photos Library.photoslibrary/database/Photos.sqlite`. A
 * community tool (osxphotos, https://github.com/RhetTbull/osxphotos) reads
 * this database directly by reverse-engineering its schema. That schema is
 * undocumented by Apple, is gated behind a macOS Full Disk Access (TCC)
 * grant, and has drifted across macOS releases (Catalina, Sonoma, Sequoia
 * have each changed table/column shape in ways that have broken
 * third-party readers). This connector does NOT implement or attempt that
 * path — it is out of scope until/unless a future connector-specific proof
 * effort takes it on, consistent with the iMessage connector's precedent
 * of never claiming Apple-official support for a reverse-engineered
 * schema. The manual Photos.app export below is the only path this
 * connector proves.
 *
 * NOTE ON EXIF/XMP: this cut does not parse EXIF or XMP sidecar metadata
 * (no date-taken, no GPS, no camera make/model — those fields are always
 * null). No EXIF-parsing dependency exists elsewhere in this package, and
 * hand-rolling a JPEG APP1/Exif reader was judged out of scope. This is a
 * bounded, explicit omission, not silently missing coverage — filename,
 * size, content hash, MIME-by-extension, file mtime, and hydrated bytes are
 * a legitimate, honest first cut on their own. This connector does not and
 * must not claim to reproduce full Apple Photos library metadata (albums,
 * people/face tags, edit history) — only what Photos.app's "Export
 * Unmodified Originals" plus file-level inspection can honestly provide.
 *
 * BLOB HYDRATION: media bytes are read, sha256-hashed, and (when the
 * runtime has blob-upload bindings configured) uploaded through
 * src/local-media-blob-hydration.ts — the SAME shared hydration module
 * google_takeout's photos stream uses, so size-cap enforcement, MIME
 * detection, hydration-status vocabulary, and the reference-blob-uploader
 * call are implemented exactly once, not duplicated per connector. A
 * record's `id` is derived from its content_sha256 alone (see
 * buildPhotoRecord in parsers.ts), so the same photo present in two
 * different Photos.app exports — or re-exported after this connector
 * already ran once — collapses to one record and one blob rather than
 * being duplicated.
 *
 * COVERAGE_DIAGNOSTICS: this connector reports one durable coverage row
 * (store "export_dir") via src/local-source-inventory.ts's
 * buildLocalSourceInventory, the same primitive claude_code/codex use. This
 * is emitted BEFORE checking whether the export directory exists — a
 * missing/empty export dir must still produce an honest "missing" coverage
 * row rather than a silent zero-evidence run, since the connection-health
 * rollup derives a local collector's coverage axis exclusively from
 * durable coverage_diagnostics records (a local run writes no spine run).
 * See openspec/changes/derive-local-collector-coverage-from-diagnostics.
 */

import { existsSync } from "node:fs";
import { opendir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runConnector } from "../../src/connector-runtime.ts";
import { hydrateMediaBytes, resolveMaxMediaBytes } from "../../src/local-media-blob-hydration.ts";
import { buildLocalSourceInventory, type KnownLocalStore } from "../../src/local-source-inventory.ts";
import { advanceCursor, buildPhotoRecord, isBeforeCursor, SUPPORTED_EXTENSIONS } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ApplePhotosState, DiscoveredFile } from "./types.ts";

const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/apple-photos";
const MAX_PHOTO_BYTES_ENV = "PDPP_APPLE_PHOTOS_MAX_PHOTO_BYTES";

const APPLE_PHOTOS_KNOWN_STORES: KnownLocalStore[] = [
  {
    store: "export_dir",
    relativePath: ".",
    stream: "photos",
    classification: "collect",
    reason: "Photos.app manual export directory (File → Export → Export Unmodified Originals)",
  },
];

// Progress cadence — emit a PROGRESS every N files so operators see motion
// on large libraries.
const PROGRESS_INTERVAL_FILES = 500;

/** The configured export directory path, regardless of whether it currently exists. */
function configuredExportDir(): string {
  return process.env.APPLE_PHOTOS_EXPORT_DIR || join(homedir(), ".pdpp/imports/apple_photos");
}

function resolveExportDir(): string | null {
  const dir = configuredExportDir();
  return existsSync(dir) ? dir : null;
}

/** True if `dir` contains no entries at all (empty top-level listing). */
async function isEmptyDir(dir: string): Promise<boolean> {
  const entries = await readdir(dir);
  return entries.length === 0;
}

function hasSupportedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  for (const ext of SUPPORTED_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively walk `dir`, yielding one DiscoveredFile per supported media
 * file. Uses async iteration over opendir so entries are streamed rather
 * than materialized into one giant array.
 */
async function* walkDir(dir: string): AsyncGenerator<DiscoveredFile> {
  const handle = await opendir(dir);
  for await (const entry of handle) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(entryPath);
      continue;
    }
    if (!(entry.isFile() && hasSupportedExtension(entry.name))) {
      continue;
    }
    const st = await stat(entryPath);
    yield {
      path: entryPath,
      sizeBytes: st.size,
      mtimeIso: st.mtime.toISOString(),
    };
  }
}

runConnector({
  name: "apple_photos",
  validateRecord,
  async collect({ state, requested, emit, emitRecord, progress }) {
    if (requested.has("coverage_diagnostics")) {
      const configuredDir = configuredExportDir();
      const inventory = await buildLocalSourceInventory(
        "apple_photos",
        dirname(configuredDir),
        APPLE_PHOTOS_KNOWN_STORES.map((store) => ({ ...store, relativePath: basename(configuredDir) }))
      );
      for (const record of inventory.coverage) {
        await emitRecord("coverage_diagnostics", record);
      }
    }

    const dir = resolveExportDir();
    if (!dir || (await isEmptyDir(dir))) {
      await emit({
        type: "SKIP_RESULT",
        stream: "photos",
        reason: "export_not_found",
        message:
          "Export photos from Photos.app (File → Export → Export Unmodified Originals) into " +
          "~/.pdpp/imports/apple_photos/ (or set APPLE_PHOTOS_EXPORT_DIR).",
      });
      return;
    }

    if (!requested.has("photos")) {
      return;
    }

    const photosState = (state.photos ?? {}) as ApplePhotosState;
    const since = photosState.last_modified;
    let latest = since;
    let fileCount = 0;
    const maxBytes = resolveMaxMediaBytes(MAX_PHOTO_BYTES_ENV);

    await progress("Apple Photos phase=emit pass=emit starting directory walk");

    for await (const file of walkDir(dir)) {
      fileCount += 1;
      if (isBeforeCursor(file.mtimeIso, since)) {
        continue;
      }
      const filename = basename(file.path);
      const hydration = await hydrateMediaBytes({
        connectorId: CONNECTOR_ID,
        fileName: filename,
        filePath: file.path,
        maxBytes,
        stream: "photos",
      });
      const record = buildPhotoRecord(file, filename, hydration);
      latest = advanceCursor(latest, file.mtimeIso);
      await emitRecord("photos", { ...record });

      if (fileCount % PROGRESS_INTERVAL_FILES === 0) {
        await progress(`Apple Photos phase=emit pass=emit files_scanned=${fileCount}`);
      }
    }

    await progress(`Apple Photos phase=emit pass=emit files_scanned=${fileCount}`);

    await emit({
      type: "STATE",
      stream: "photos",
      cursor: { last_modified: latest },
    });
  },
});
