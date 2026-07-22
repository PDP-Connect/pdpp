// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { mountNekoViewer } from "./neko-viewer-mount.ts";

test("NekoClientApi.start rejection reaches the console inline-error boundary and releases the mount", async () => {
  let adapterReleased = false;
  let adapterUnmounts = 0;
  let inlineError: string | null = null;
  let viewerMounted = false;
  let viewerUnmounts = 0;

  const viewer = {
    mount(_container: HTMLElement): Promise<void> {
      viewerMounted = true;
      throw new Error("NekoClientApi.start failed");
    },
    unmount(): void {
      viewerMounted = false;
      viewerUnmounts += 1;
    },
  };

  await mountNekoViewer({
    adapter: {
      unmount(): Promise<void> {
        adapterUnmounts += 1;
        return Promise.resolve();
      },
    },
    container: {} as HTMLElement,
    onAdapterReleased: () => {
      adapterReleased = true;
    },
    viewer,
  }).catch((error: unknown) => {
    inlineError = error instanceof Error ? error.message : String(error);
  });

  assert.equal(inlineError, "NekoClientApi.start failed");
  assert.equal(viewerMounted, false);
  assert.equal(viewerUnmounts, 1);
  assert.equal(adapterUnmounts, 1);
  assert.equal(adapterReleased, true);
});
