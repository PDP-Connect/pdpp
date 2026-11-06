// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, mock, test } from "node:test";
import { SHARE_CARD_FORMATS } from "@/lib/share-card/copy.ts";
import { GET, generateStaticParams } from "./route.tsx";

const PNG_SIGNATURE = "89504e470d0a1a0a";

// The card downloads its fonts from Google Fonts. The tests stay offline: every
// stylesheet request gets a stub pointing at one file, and that file is the
// TrueType font next/og ships with.
const TEST_FONT = readFileSync(
  createRequire(import.meta.url).resolve("next/dist/compiled/@vercel/og/Geist-Regular.ttf")
);
const TEST_FONT_URL = "https://fonts.gstatic.com/test/Geist-Regular.ttf";

before(() => {
  const realFetch = globalThis.fetch;
  // Only Google Fonts is stubbed; next/og loads its own WebAssembly through fetch too.
  mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === TEST_FONT_URL) {
      return Promise.resolve(new Response(TEST_FONT));
    }
    if (url.startsWith("https://fonts.googleapis.com/")) {
      return Promise.resolve(new Response(`src: url(${TEST_FONT_URL}) format('truetype');`));
    }
    return realFetch(input, init);
  });
});

after(() => {
  mock.restoreAll();
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
  test(`${format} returns a PNG of ${SHARE_CARD_FORMATS[format].width}x${SHARE_CARD_FORMATS[format].height}`, async () => {
    const response = await request(format);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(pngSize(Buffer.from(await response.arrayBuffer())), {
      ...SHARE_CARD_FORMATS[format],
      signature: PNG_SIGNATURE,
    });
  });
}

test("an unknown format is a 404", async () => {
  assert.equal((await request("banner")).status, 404);
});
