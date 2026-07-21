// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  type PlaywrightDownloadLike,
  readPlaywrightDownloadBuffer,
  readPlaywrightDownloadBufferDetailed,
  savePlaywrightDownload,
  savePlaywrightDownloadDetailed,
} from "./playwright-download.ts";

test("savePlaywrightDownload: delegates artifact waiting to saveAs without reading path()", async () => {
  const calls: string[] = [];
  const mock: PlaywrightDownloadLike = {
    async saveAs(target: string): Promise<void> {
      calls.push("saveAs");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(target, Buffer.from("ok"));
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

test("savePlaywrightDownloadDetailed: recovers data URL downloads before remote artifact transfer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-data-url-test-"));
  try {
    const target = join(dir, "out.csv");
    const mock: PlaywrightDownloadLike = {
      saveAs(): Promise<void> {
        throw new Error("saveAs should not be called for data URLs");
      },
      url(): string {
        return "data:text/csv;charset=utf-8,Date,Description%0A2026-05-27,%22USAA%20Credit%20Card%22";
      },
    };
    const outcome = await savePlaywrightDownloadDetailed(mock, target);
    assert.equal(outcome.source, "dataUrl");
    assert.equal(await readFile(target, "utf8"), 'Date,Description\n2026-05-27,"USAA Credit Card"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("savePlaywrightDownloadDetailed: recovers base64 data URL downloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-data-url-base64-test-"));
  try {
    const target = join(dir, "out.csv");
    const mock: PlaywrightDownloadLike = {
      saveAs(): Promise<void> {
        throw new Error("saveAs should not be called for data URLs");
      },
      url(): string {
        return `data:text/csv;base64,${Buffer.from("Date,Amount\n2026-05-27,1.23").toString("base64")}`;
      },
    };
    const outcome = await savePlaywrightDownloadDetailed(mock, target);
    assert.equal(outcome.source, "dataUrl");
    assert.equal(await readFile(target, "utf8"), "Date,Amount\n2026-05-27,1.23");
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

test("savePlaywrightDownloadDetailed: zero-byte saveAs triggers createReadStream fallback", async () => {
  // Remote CDP (n.eko) can complete saveAs without throwing but write zero
  // bytes. Without the fallback, the connector reports `download_empty` with
  // no recovery and no evidence about why the artifact transfer failed.
  const dir = await mkdtemp(join(tmpdir(), "pdpp-playwright-download-zero-saveas-test-"));
  try {
    const target = join(dir, "out.bin");
    const mock: PlaywrightDownloadLike = {
      async saveAs(path: string): Promise<void> {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, Buffer.from(""));
      },
      createReadStream(): Promise<Readable> {
        return Promise.resolve(Readable.from(Buffer.from("recovered-via-stream")));
      },
    };
    const outcome = await savePlaywrightDownloadDetailed(mock, target);
    assert.equal(outcome.source, "createReadStream");
    assert.equal(outcome.saveAsError, "saveAs_returned_zero_bytes");
    assert.equal(outcome.bytes, "recovered-via-stream".length);
    assert.equal(await readFile(target, "utf8"), "recovered-via-stream");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readPlaywrightDownloadBufferDetailed: returns outcome metadata for the happy path", async () => {
  const mock: PlaywrightDownloadLike = {
    async saveAs(path: string): Promise<void> {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, Buffer.from("hello"));
    },
    suggestedFilename(): string {
      return "export.csv";
    },
  };
  const { buffer, outcome } = await readPlaywrightDownloadBufferDetailed(mock);
  assert.equal(buffer.toString("utf8"), "hello");
  assert.equal(outcome.source, "saveAs");
  assert.equal(outcome.bytes, 5);
  assert.equal(outcome.saveAsError, undefined);
});

test("readPlaywrightDownloadBufferDetailed: surfaces zero-byte fallback evidence when both paths fail", async () => {
  const mock: PlaywrightDownloadLike = {
    async saveAs(path: string): Promise<void> {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, Buffer.from(""));
    },
    createReadStream(): Promise<Readable> {
      return Promise.resolve(Readable.from(Buffer.from("")));
    },
    failure(): Promise<string | null> {
      return Promise.resolve("server canceled the transfer");
    },
    suggestedFilename(): string {
      return "export.csv";
    },
  };
  const { buffer, outcome } = await readPlaywrightDownloadBufferDetailed(mock);
  // Both transports completed without throwing, but produced zero bytes.
  // Caller is expected to treat outcome.bytes === 0 as a failure and pull
  // the failure reason from outcome.saveAsError + download.failure().
  assert.equal(buffer.length, 0);
  assert.equal(outcome.source, "createReadStream");
  assert.equal(outcome.saveAsError, "saveAs_returned_zero_bytes");
  assert.equal(outcome.bytes, 0);
});
