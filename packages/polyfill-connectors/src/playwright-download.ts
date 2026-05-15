/**
 * Shared helper for persisting a Playwright `Download` artifact to disk.
 *
 * Playwright's `download.saveAs()` is the synchronization primitive: it is
 * safe to call while the download is still in progress and waits for the
 * artifact before copying it. Do not call `download.path()` first. In remote
 * CDP/containerized browser surfaces, `path()` exposes the browser-side
 * artifact path, which may be unavailable to the connector process.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Download } from "playwright";

export type PlaywrightDownloadLike = Pick<Download, "saveAs">;

export async function savePlaywrightDownload(download: PlaywrightDownloadLike, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await download.saveAs(targetPath);
}
