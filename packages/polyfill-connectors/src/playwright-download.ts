/**
 * Shared helper for persisting a Playwright `Download` artifact to disk.
 *
 * Why this exists: Patchright/Playwright fires the `download` event when the
 * response *starts*, but the temp file at /tmp/playwright-artifacts-<id>/<uuid>
 * is only finalized once the body has fully streamed. Calling `saveAs` too
 * early — before Chromium has flushed the artifact — can race against the
 * temp-file write and surface as `ENOENT: no such file or directory` on the
 * Playwright side (see chase run_1778852923848 statement-PDF gaps).
 *
 * `download.path()` blocks until Chromium reports the artifact as finalized,
 * which is the correct synchronization primitive here. We await it before
 * `saveAs` so that the subsequent copy reads a fully-written source.
 *
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Download } from "playwright";

export type PlaywrightDownloadLike = Pick<Download, "path" | "saveAs">;

export async function savePlaywrightDownload(download: PlaywrightDownloadLike, targetPath: string): Promise<void> {
  // Await artifact finalization before copying — see file header for why.
  await download.path();
  await mkdir(dirname(targetPath), { recursive: true });
  await download.saveAs(targetPath);
}
