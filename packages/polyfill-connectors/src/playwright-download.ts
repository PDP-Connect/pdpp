/**
 * Shared helper for persisting a Playwright `Download` artifact to disk.
 *
 * Playwright's `download.saveAs()` is the primary synchronization primitive:
 * it is safe to call while the download is still in progress and waits for
 * the artifact before copying it. If a remote browser reports a Download but
 * its backing file disappears before `saveAs()` can copy it, fall back to the
 * official `createReadStream()` API. Do not call `download.path()` first:
 * official Playwright docs note that `path()` throws when connected remotely,
 * which is exactly the shape used by Docker/n.eko browser surfaces.
 */

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Download } from "playwright";

export type PlaywrightDownloadLike = Pick<Download, "saveAs"> &
  Partial<Pick<Download, "createReadStream" | "failure" | "suggestedFilename">>;

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
  try {
    await download.saveAs(targetPath);
  } catch (saveErr) {
    if (!download.createReadStream) {
      throw saveErr;
    }
    try {
      const stream = await download.createReadStream();
      await pipeline(stream, createWriteStream(targetPath));
    } catch (streamErr) {
      const failure = download.failure ? await download.failure().catch((): null => null) : null;
      throw new Error(
        `download.saveAs failed (${downloadErrorMessage(saveErr)}); createReadStream failed (${downloadErrorMessage(
          streamErr
        )})${failure ? `; download.failure=${failure}` : ""}`
      );
    }
  }
}

function downloadErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
