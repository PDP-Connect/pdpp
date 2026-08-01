// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Download, Page } from "playwright";
import { attachDownloadQueue } from "./download-queue.ts";

function fakePage(): { emitDownload: (dl: Download) => void; page: Page } {
  const emitter = new EventEmitter();
  const fake: Partial<Page> = {};
  fake.on = ((event: string, listener: (...args: unknown[]) => void) => {
    emitter.on(event, listener);
    return fake;
  }) as Page["on"];
  fake.off = ((event: string, listener: (...args: unknown[]) => void) => {
    emitter.off(event, listener);
    return fake;
  }) as Page["off"];
  return { emitDownload: (dl) => emitter.emit("download", dl), page: fake as Page };
}

function fakeDownload(name: string): Download {
  const fake: Partial<Download> = {};
  fake.suggestedFilename = (() => name) as Download["suggestedFilename"];
  return fake as Download;
}

test("waitForNextDownload resolves from a pending download queued before the call", async () => {
  const { emitDownload, page } = fakePage();
  const queue = attachDownloadQueue(page);
  emitDownload(fakeDownload("a.pdf"));
  const dl = await queue.waitForNextDownload({ timeoutMs: 1000 });
  assert.equal(dl.suggestedFilename(), "a.pdf");
  queue.detach();
});

test("waitForNextDownload rejects after timeoutMs when no download arrives", async () => {
  const { page } = fakePage();
  const queue = attachDownloadQueue(page);
  await assert.rejects(queue.waitForNextDownload({ timeoutMs: 20 }), /download_timeout/);
  queue.detach();
});

test("detach() immediately rejects an outstanding waiter instead of leaving its timer to fire later", async () => {
  const { page } = fakePage();
  const queue = attachDownloadQueue(page);
  const waitPromise = queue.waitForNextDownload({ timeoutMs: 60_000 });
  waitPromise.catch((): undefined => undefined);

  const start = Date.now();
  queue.detach();
  await assert.rejects(waitPromise, /download_queue_detached/);
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 1000, `expected immediate rejection on detach, took ${elapsedMs}ms`);
});

test("a late download after timeout is requeued for a subsequent waiter rather than dropped", async () => {
  const { emitDownload, page } = fakePage();
  const queue = attachDownloadQueue(page);
  await assert.rejects(queue.waitForNextDownload({ timeoutMs: 20 }), /download_timeout/);
  emitDownload(fakeDownload("late.pdf"));
  assert.equal(queue.pendingCount(), 1);
  const dl = await queue.waitForNextDownload({ timeoutMs: 1000 });
  assert.equal(dl.suggestedFilename(), "late.pdf");
  queue.detach();
});
