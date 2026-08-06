// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sameOriginStreamUrls } from "./streaming-protocol.ts";

const STREAM_PATH = /^\/_ref\/run-interaction-streams\//;
const SAME_ORIGIN_MAPPER_CALL = /sameOriginStreamUrls\(minted\)/;
const ABSOLUTE_ORIGIN_CONVERTER = /getReferencePublicUrl/;

test("stream endpoints follow the dashboard origin on a custom Docker host port", () => {
  const urls = sameOriginStreamUrls({
    clipboard_path: "/_ref/run-interaction-streams/token/clipboard",
    input_path: "/_ref/run-interaction-streams/token/input",
    viewer_path: "/_ref/run-interaction-streams/token/events",
    viewport_path: "/_ref/run-interaction-streams/token/viewport",
  });

  for (const url of Object.values(urls)) {
    assert.match(url, STREAM_PATH);
    assert.equal(new URL(url, "http://localhost:3012").origin, "http://localhost:3012");
  }
});

test("stream endpoints normalize server paths without introducing an origin", () => {
  assert.deepEqual(
    sameOriginStreamUrls({
      clipboard_path: "_ref/stream/clipboard",
      input_path: "_ref/stream/input",
      viewer_path: "_ref/stream/events",
      viewport_path: "_ref/stream/viewport",
    }),
    {
      clipboard_url: "/_ref/stream/clipboard",
      input_url: "/_ref/stream/input",
      viewer_url: "/_ref/stream/events",
      viewport_url: "/_ref/stream/viewport",
    }
  );
});

test("the mint action returns same-origin paths instead of configured absolute URLs", async () => {
  const source = await readFile(new URL("./actions.ts", import.meta.url), "utf8");

  assert.match(source, SAME_ORIGIN_MAPPER_CALL);
  assert.doesNotMatch(source, ABSOLUTE_ORIGIN_CONVERTER);
});
