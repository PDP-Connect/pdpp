import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type PlaywrightDownloadLike, savePlaywrightDownload } from "./playwright-download.ts";

test("savePlaywrightDownload: delegates artifact waiting to saveAs without reading path()", async () => {
  const calls: string[] = [];
  const mock: PlaywrightDownloadLike = {
    saveAs(_target: string): Promise<void> {
      calls.push("saveAs");
      return Promise.resolve();
    },
  };

  const dir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-reject-test-"));
  try {
    const target = join(dir, "out.bin");
    await savePlaywrightDownload(mock, target);
    assert.deepEqual(calls, ["saveAs"], "saveAs owns Playwright artifact synchronization");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("savePlaywrightDownload: creates the destination directory before saveAs writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-mkdir-test-"));
  try {
    const target = join(dir, "nested", "deeper", "out.bin");
    const mock: PlaywrightDownloadLike = {
      async saveAs(path: string): Promise<void> {
        // Simulate Playwright's behavior: copy a known buffer to target.
        // If mkdir wasn't called first this throws ENOENT.
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, Buffer.from("ok"));
      },
    };
    await savePlaywrightDownload(mock, target);
    assert.equal(await readFile(target, "utf8"), "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
