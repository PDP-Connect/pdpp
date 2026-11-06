// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SHARE_CARD_FORMATS } from "@/lib/share-card/copy.ts";
import { GET, generateStaticParams } from "./route.tsx";

const FLAG = "NEXT_PUBLIC_PDPP_SHARE_CARD";
const PNG_SIGNATURE = "89504e470d0a1a0a";

afterEach(() => {
  delete process.env[FLAG];
});

function request(format: string): Promise<Response> {
  return GET(new Request(`https://pdpp.dev/principles/card/${format}`), { params: Promise.resolve({ format }) });
}

// A PNG starts with an 8-byte signature, then the IHDR chunk: length, "IHDR",
// then width and height as big-endian 32-bit integers at bytes 16 and 20.
function pngSize(png: Buffer): { height: number; signature: string; width: number } {
  return {
    height: png.readUInt32BE(20),
    signature: png.subarray(0, 8).toString("hex"),
    width: png.readUInt32BE(16),
  };
}

test("the card routes are built for exactly the feed and story formats", () => {
  assert.deepEqual(generateStaticParams(), [{ format: "feed" }, { format: "story" }]);
});

for (const format of ["feed", "story"] as const) {
  test(`${format} returns a PNG of ${SHARE_CARD_FORMATS[format].width}x${SHARE_CARD_FORMATS[format].height} when the flag is true`, async () => {
    process.env[FLAG] = "true";
    const response = await request(format);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(pngSize(Buffer.from(await response.arrayBuffer())), {
      ...SHARE_CARD_FORMATS[format],
      signature: PNG_SIGNATURE,
    });
  });
}

test("an unknown format is a 404 even when the flag is on", async () => {
  process.env[FLAG] = "true";
  assert.equal((await request("banner")).status, 404);
});

for (const value of [undefined, "", "0", "1", "false", "yes"]) {
  test(`the routes are a 404 when the flag is ${JSON.stringify(value)}`, async () => {
    if (value === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = value;
    }
    const [feed, story] = await Promise.all([request("feed"), request("story")]);
    assert.deepEqual([feed.status, story.status], [404, 404]);
  });
}
