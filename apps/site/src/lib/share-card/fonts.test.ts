// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { fontCssUrl, loadCardFonts } from "./fonts.ts";

const NO_TRUETYPE = /no TrueType file for Inter normal 400/;
const SERVER_ERROR = /returned 500/;

const CSS = (file: string) => `@font-face { src: url(https://fonts.gstatic.com/${file}) format('truetype'); }`;

function fakeFetch(handler: (url: string) => Response | Promise<Response>): { calls: string[]; fetch: typeof fetch } {
  const calls: string[] = [];
  const fetchFn = ((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
}

test("the stylesheet URL asks for the one weight and style the card uses", () => {
  assert.equal(
    fontCssUrl({ name: "Inter", style: "normal", weight: 700 }),
    "https://fonts.googleapis.com/css2?family=Inter:wght@700"
  );
  assert.equal(
    fontCssUrl({ name: "Source Serif 4", style: "italic", weight: 400 }),
    "https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,wght@1,400"
  );
});

test("each font is read from the TrueType file its stylesheet names", async () => {
  const { fetch } = fakeFetch((url) =>
    url.startsWith("https://fonts.googleapis.com/")
      ? new Response(CSS(encodeURIComponent(url)))
      : new Response(new TextEncoder().encode(url))
  );
  const fonts = await loadCardFonts(fetch);
  assert.deepEqual(
    fonts.map(({ name, style, weight }) => `${name} ${style} ${weight}`),
    ["Inter normal 400", "Inter normal 700", "Source Serif 4 normal 400", "Source Serif 4 italic 400"]
  );
  for (const font of fonts) {
    const fileUrl = new TextDecoder().decode(font.data);
    assert.ok(fileUrl.includes(encodeURIComponent(fontCssUrl(font))), `${font.name} got another font's file`);
  }
});

test("a failed request is retried before the build gives up", async () => {
  let failures = 2;
  const { calls, fetch } = fakeFetch((url) => {
    if (url.includes("family=Inter:wght@400") && failures > 0) {
      failures -= 1;
      return new Response("busy", { status: 503 });
    }
    return url.startsWith("https://fonts.googleapis.com/") ? new Response(CSS("f.ttf")) : new Response("ttf");
  });
  await loadCardFonts(fetch);
  assert.equal(calls.filter((url) => url.includes("family=Inter:wght@400")).length, 3);
});

test("a stylesheet without a TrueType file fails loudly", async () => {
  const { fetch } = fakeFetch(() => new Response("src: url(https://fonts.gstatic.com/f.woff2) format('woff2');"));
  await assert.rejects(loadCardFonts(fetch), NO_TRUETYPE);
});

test("Google Fonts being down fails the load after three tries", async () => {
  const { calls, fetch } = fakeFetch(() => new Response("down", { status: 500 }));
  await assert.rejects(loadCardFonts(fetch), SERVER_ERROR);
  assert.equal(calls.filter((url) => url.includes("family=Inter:wght@400")).length, 3);
});

test("a TrueType file that never becomes available rejects the whole font load", async () => {
  const failedFile = "https://fonts.gstatic.com/unavailable.ttf";
  const targetCss = fontCssUrl({ name: "Inter", style: "normal", weight: 700 });
  const { calls, fetch } = fakeFetch((url) => {
    if (url === targetCss) {
      return new Response(CSS("unavailable.ttf"));
    }
    if (url.startsWith("https://fonts.googleapis.com/")) {
      return new Response(CSS("other.ttf"));
    }
    return url === failedFile ? new Response("missing", { status: 404 }) : new Response("fixture");
  });
  await assert.rejects(loadCardFonts(fetch), /unavailable\.ttf returned 404/);
  assert.equal(calls.filter((url) => url === failedFile).length, 3);
});

test("a stylesheet that offers WOFF2 first still loads only its TrueType file", async () => {
  const { calls, fetch } = fakeFetch((url) =>
    url.startsWith("https://fonts.googleapis.com/")
      ? new Response(`@font-face { src: url(https://fonts.gstatic.com/skip.woff2) format('woff2'); } ${CSS("card.ttf")}`)
      : new Response("synthetic font bytes")
  );
  const fonts = await loadCardFonts(fetch);
  assert.equal(fonts.length, 4);
  assert.equal(calls.filter((url) => url.endsWith("/card.ttf")).length, 4);
  assert.equal(calls.some((url) => url.endsWith("/skip.woff2")), false);
});
