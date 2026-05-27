/**
 * Shared helper for persisting a Playwright `Download` artifact to disk.
 *
 * Playwright's `download.saveAs()` is the synchronization primitive: it is
 * safe to call while the download is still in progress and waits for the
 * artifact before copying it. Do not call `download.path()` first: official
 * Playwright docs note that `path()` throws when connected remotely, which is
 * exactly the shape used by Docker/n.eko browser surfaces.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Download } from "playwright";

export type PlaywrightDownloadLike = Pick<Download, "saveAs"> & Partial<Pick<Download, "suggestedFilename">>;

export async function readPlaywrightDownloadBuffer(download: PlaywrightDownloadLike): Promise<Buffer> {
  const tempDir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-"));
  try {
    const target = join(tempDir, download.suggestedFilename?.() || "download.bin");
    await savePlaywrightDownload(download, target);
    return await readFile(target);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function savePlaywrightDownload(download: PlaywrightDownloadLike, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await download.saveAs(targetPath);
}
