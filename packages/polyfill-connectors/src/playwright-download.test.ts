import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  type PlaywrightDownloadLike,
  readPlaywrightDownloadBuffer,
  savePlaywrightDownload,
} from "./playwright-download.ts";

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

test("readPlaywrightDownloadBuffer: reads via saveAs without depending on download.path()", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-path-test-"));
  try {
    const mock: PlaywrightDownloadLike = {
      async saveAs(path: string): Promise<void> {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, Buffer.from("from-save-as"));
      },
    };

    assert.equal((await readPlaywrightDownloadBuffer(mock)).toString("utf8"), "from-save-as");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("savePlaywrightDownload: falls back to createReadStream when saveAs cannot copy the artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-stream-test-"));
  try {
    const target = join(dir, "out.bin");
    const mock: PlaywrightDownloadLike = {
      createReadStream(): Promise<Readable> {
        return Promise.resolve(Readable.from(Buffer.from("from-stream")));
      },
      saveAs(): Promise<void> {
        return Promise.reject(new Error("ENOENT: missing playwright artifact"));
      },
    };
    await savePlaywrightDownload(mock, target);
    assert.equal(await readFile(target, "utf8"), "from-stream");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("savePlaywrightDownload: reports saveAs, stream, and download failure when both artifact paths fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-failure-test-"));
  try {
    const target = join(dir, "out.bin");
    const mock: PlaywrightDownloadLike = {
      createReadStream(): Promise<Readable> {
        return Promise.reject(new Error("stream gone"));
      },
      failure(): Promise<string | null> {
        return Promise.resolve("canceled");
      },
      saveAs(): Promise<void> {
        return Promise.reject(new Error("saveAs gone"));
      },
    };
    await assert.rejects(savePlaywrightDownload(mock, target), /saveAs gone.*stream gone.*download.failure=canceled/s);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
