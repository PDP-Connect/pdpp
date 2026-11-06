// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The card is set in the site's own typefaces, Inter and Source Serif 4. The
// site gets them from Google Fonts through next/font, which serves only woff2;
// next/og needs TrueType, so the card asks the same Google Fonts API for
// TrueType files when it is built. The site build already depends on Google
// Fonts being reachable, so this adds no new way for a build to fail.

const CSS_API = "https://fonts.googleapis.com/css2";
const TRUETYPE_URL = /src: url\((https:\/\/[^)]+)\) format\('truetype'\)/;
const ATTEMPTS = 3;

export interface CardFont {
  data: ArrayBuffer;
  name: string;
  style: "italic" | "normal";
  weight: 400 | 700;
}

type FontSpec = Omit<CardFont, "data">;

const CARD_FONTS: readonly FontSpec[] = [
  { name: "Inter", style: "normal", weight: 400 },
  { name: "Inter", style: "normal", weight: 700 },
  { name: "Source Serif 4", style: "normal", weight: 400 },
  { name: "Source Serif 4", style: "italic", weight: 400 },
];

export function fontCssUrl({ name, style, weight }: FontSpec): string {
  const axes = style === "italic" ? `ital,wght@1,${weight}` : `wght@${weight}`;
  return `${CSS_API}?family=${name.replaceAll(" ", "+")}:${axes}`;
}

async function fetchOk(fetchFn: typeof fetch, url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: a retry has to wait for the attempt before it.
      const response = await fetchFn(url, { cache: "force-cache" });
      if (response.ok) {
        return response;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function loadFont(fetchFn: typeof fetch, spec: FontSpec): Promise<CardFont> {
  const css = await (await fetchOk(fetchFn, fontCssUrl(spec))).text();
  const fileUrl = TRUETYPE_URL.exec(css)?.[1];
  if (!fileUrl) {
    throw new Error(`Google Fonts returned no TrueType file for ${spec.name} ${spec.style} ${spec.weight}`);
  }
  const data = await (await fetchOk(fetchFn, fileUrl)).arrayBuffer();
  return { ...spec, data };
}

/** Downloads the four card fonts. Rejects if any of them cannot be loaded. */
export function loadCardFonts(fetchFn: typeof fetch = fetch): Promise<CardFont[]> {
  return Promise.all(CARD_FONTS.map((spec) => loadFont(fetchFn, spec)));
}
