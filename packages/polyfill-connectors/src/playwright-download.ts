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
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Download } from "playwright";

export type PlaywrightDownloadLike = Pick<Download, "saveAs"> &
  Partial<Pick<Download, "createReadStream" | "path" | "suggestedFilename">>;

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function firstNonEmpty(buffer: Buffer, fallback: Buffer | null): Buffer | null {
  return buffer.length > 0 ? buffer : fallback;
}

export async function readPlaywrightDownloadBuffer(download: PlaywrightDownloadLike): Promise<Buffer> {
  let emptyFallback: Buffer | null = null;

  if (typeof download.createReadStream === "function") {
    const stream = await download.createReadStream();
    if (stream) {
      const buffer = await streamToBuffer(stream);
      if (buffer.length > 0) {
        return buffer;
      }
      emptyFallback = buffer;
    }
  }

  const path = typeof download.path === "function" ? await download.path().catch((): string | null => null) : null;
  if (path) {
    const buffer = await readFile(path);
    if (buffer.length > 0) {
      return buffer;
    }
    emptyFallback = firstNonEmpty(buffer, emptyFallback);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-"));
  try {
    const target = join(tempDir, download.suggestedFilename?.() || "download.bin");
    await download.saveAs(target);
    const buffer = await readFile(target);
    return firstNonEmpty(buffer, emptyFallback) ?? buffer;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

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
