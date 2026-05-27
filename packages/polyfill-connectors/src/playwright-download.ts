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
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Download } from "playwright";

export type PlaywrightDownloadLike = Pick<Download, "saveAs"> &
  Partial<Pick<Download, "createReadStream" | "failure" | "suggestedFilename">>;

/**
 * Diagnostic info captured while persisting a Playwright Download. Surfaced
 * up to callers so a `download_empty` outcome carries the evidence needed
 * to root-cause it (saveAs error string, stream fallback bytes/error, the
 * remote browser's own `download.failure()` report) instead of being a
 * blind dead-end.
 */
export interface PlaywrightDownloadOutcome {
  bytes: number;
  downloadFailure?: string | null;
  saveAsError?: string;
  source: "saveAs" | "createReadStream";
  streamError?: string;
}

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

/**
 * Persist a Playwright Download and return rich outcome metadata. Identical
 * to `readPlaywrightDownloadBuffer` for the happy path, but reports the
 * fallback path taken and the byte count actually written. Used by the USAA
 * export driver to surface `download_empty` evidence in the timeline.
 */
export async function readPlaywrightDownloadBufferDetailed(
  download: PlaywrightDownloadLike
): Promise<{ buffer: Buffer; outcome: PlaywrightDownloadOutcome }> {
  const tempDir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-"));
  try {
    const target = join(tempDir, download.suggestedFilename?.() || "download.bin");
    const outcome = await savePlaywrightDownloadDetailed(download, target);
    const buffer = await readFile(target);
    return { buffer, outcome: { ...outcome, bytes: buffer.length } };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function savePlaywrightDownload(download: PlaywrightDownloadLike, targetPath: string): Promise<void> {
  await savePlaywrightDownloadDetailed(download, targetPath);
}

/**
 * Try `saveAs` (Playwright's documented primary primitive), and fall back
 * to `createReadStream` when it either throws or silently writes a zero-byte
 * artifact. The zero-byte case has been observed with `connectOverCDP`-style
 * remote browsers (n.eko) where the artifact transfer can complete without
 * an error but without bytes — exactly the failure mode the USAA export
 * driver was hitting under `download_empty`.
 */
export async function savePlaywrightDownloadDetailed(
  download: PlaywrightDownloadLike,
  targetPath: string
): Promise<PlaywrightDownloadOutcome> {
  await mkdir(dirname(targetPath), { recursive: true });
  let saveAsError: string | undefined;
  try {
    await download.saveAs(targetPath);
    const size = await statSize(targetPath);
    if (size > 0) {
      return { bytes: size, source: "saveAs" };
    }
    saveAsError = "saveAs_returned_zero_bytes";
  } catch (saveErr) {
    saveAsError = downloadErrorMessage(saveErr);
  }
  if (!download.createReadStream) {
    const failure = download.failure ? await download.failure().catch((): null => null) : null;
    throw new Error(`download.saveAs failed (${saveAsError})${failure ? `; download.failure=${failure}` : ""}`);
  }
  try {
    const stream = await download.createReadStream();
    await pipeline(stream, createWriteStream(targetPath));
    const size = await statSize(targetPath);
    return { bytes: size, source: "createReadStream", saveAsError };
  } catch (streamErr) {
    const failure = download.failure ? await download.failure().catch((): null => null) : null;
    throw new Error(
      `download.saveAs failed (${saveAsError}); createReadStream failed (${downloadErrorMessage(
        streamErr
      )})${failure ? `; download.failure=${failure}` : ""}`
    );
  }
}

async function statSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.size;
  } catch {
    return 0;
  }
}

function downloadErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
