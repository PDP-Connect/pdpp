import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type PlaywrightDownloadLike, savePlaywrightDownload } from "./playwright-download.ts";

test("savePlaywrightDownload: awaits download.path() BEFORE invoking saveAs (call-order)", async () => {
  const calls: string[] = [];
  // path() resolves on the next macrotask so any sync-after-path branch in
  // savePlaywrightDownload would still record the wrong order if it skipped
  // the await. We use a deferred to make the ordering observable even if
  // path() were not actually awaited.
  let resolvePath: (value: string) => void = (): void => {
    throw new Error("resolvePath not yet bound");
  };
  const pathPromise = new Promise<string>((resolve): void => {
    resolvePath = resolve;
  });

  const mock: PlaywrightDownloadLike = {
    path(): Promise<string> {
      calls.push("path");
      return pathPromise;
    },
    saveAs(_target: string): Promise<void> {
      calls.push("saveAs");
      return Promise.resolve();
    },
  };

  const dir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-test-"));
  try {
    const target = join(dir, "nested", "out.bin");
    const op = savePlaywrightDownload(mock, target);
    // Yield several microtasks; if savePlaywrightDownload were not actually
    // awaiting path(), saveAs would already have been recorded.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls, ["path"], "saveAs must not be invoked until path() resolves");
    resolvePath("/tmp/playwright-artifacts-x/y");
    await op;
    assert.deepEqual(calls, ["path", "saveAs"], "saveAs must be invoked after path() resolves");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("savePlaywrightDownload: if path() rejects, saveAs is NOT invoked and error propagates", async () => {
  const calls: string[] = [];
  const mock: PlaywrightDownloadLike = {
    path(): Promise<string> {
      calls.push("path");
      return Promise.reject(new Error("artifact-finalize-failed"));
    },
    saveAs(_target: string): Promise<void> {
      calls.push("saveAs");
      return Promise.resolve();
    },
  };

  const dir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-reject-test-"));
  try {
    const target = join(dir, "out.bin");
    await assert.rejects(savePlaywrightDownload(mock, target), /artifact-finalize-failed/);
    assert.deepEqual(calls, ["path"], "saveAs must not be called when path() rejects");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("savePlaywrightDownload: creates the destination directory before saveAs writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-mkdir-test-"));
  try {
    const target = join(dir, "nested", "deeper", "out.bin");
    const mock: PlaywrightDownloadLike = {
      path(): Promise<string> {
        return Promise.resolve("/tmp/playwright-artifacts-x/y");
      },
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
