/**
 * Shared helper for persisting a Playwright `Download` artifact to disk.
 *
 * Prefer `download.createReadStream()` over `download.saveAs()` when
 * available. In remote CDP/containerized browser surfaces, `saveAs()` can
 * race while copying Playwright's local temp artifact and fail with ENOENT.
 * Streaming reads the artifact through Playwright's download channel instead
 * of depending on a temp path staying addressable.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Download } from "playwright";

export type PlaywrightDownloadLike = Pick<Download, "saveAs"> & Partial<Pick<Download, "createReadStream">>;

export async function savePlaywrightDownload(download: PlaywrightDownloadLike, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  if (typeof download.createReadStream === "function") {
    const stream = await download.createReadStream();
    if (stream) {
      await pipeline(stream, createWriteStream(targetPath, { mode: 0o600 }));
      return;
    }
  }
  await download.saveAs(targetPath);
}
