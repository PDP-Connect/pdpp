// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { ReactElement } from "react";
import { WORDMARK_PATH } from "../../components/elements/icons.tsx";
import { SHARE_CARD_COPY, SHARE_CARD_FORMATS, type ShareCardFormat } from "./copy.ts";

// Colours of the concept surface (the live site), as hex. Satori cannot parse oklch(),
// so each is the sRGB value of a light-scheme token in
// src/styles/surfaces/concept/tokens/primitive.css. Re-derive them if a token moves.
const PAPER = "#f4f5f6"; // --background = --pdpp-editorial-paper, oklch(0.97 0.001 245)
const INK = "#181b1d"; // --foreground = --pdpp-editorial-ink, oklch(0.22 0.006 245)
const MUTED = "#4e5052"; // --muted-foreground = --pdpp-editorial-ink-soft
const PRIMARY = "#295171"; // --primary = --pdpp-editorial-teal, oklch(0.42 0.07 245); also the header wordmark colour
const ON_PRIMARY = "#f4f5f6"; // --primary-foreground = --pdpp-editorial-onteal-deep
const BORDER = "#cccecf"; // --border = 18% of --foreground mixed into --background

/**
 * The header wordmark as the site draws it: the same path and viewBox as
 * WordmarkIcon, filled with the site's primary colour (the header sets `text-primary`).
 */
export function wordmarkSvg(fill: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 365 160"><path d="${WORDMARK_PATH}" fill="${fill}"/></svg>`;
}

const ASSETS = join(process.cwd(), "assets", "share-card");

// Read once per process. The files ship with the repo; nothing is fetched.
const fonts = Promise.all([
  readFile(join(ASSETS, "Inter-Regular.ttf")),
  readFile(join(ASSETS, "Inter-Bold.ttf")),
  readFile(join(ASSETS, "SourceSerif4-Regular.ttf")),
  readFile(join(ASSETS, "SourceSerif4-It.ttf")),
]);
const wordmarkDataUri = `data:image/svg+xml;base64,${Buffer.from(wordmarkSvg(PRIMARY)).toString("base64")}`;

/** Per-format measurements. The design is the same; only the room around it changes. */
interface Layout {
  /** Space above and below the content; Stories keeps clear of the app's own header and reply bar. */
  padBottom: number;
  padTop: number;
  statementSize: number;
}

const LAYOUTS: Record<ShareCardFormat, Layout> = {
  feed: { padBottom: 80, padTop: 80, statementSize: 168 },
  story: { padBottom: 280, padTop: 250, statementSize: 184 },
};

interface DesignProps {
  layout: Layout;
  wordmark: string;
}

// The wordmark's box is 365 x 160 (see WordmarkIcon).
const WORDMARK_HEIGHT = 56;
const WORDMARK_WIDTH = Math.round((WORDMARK_HEIGHT * 365) / 160);

/**
 * The card's designs. Adding another is a new entry here and a new value of
 * `ShareCardVariant`; the route, sizes, fonts and copy do not change.
 *
 * It follows the concept surface: flat paper, ink type, a serif statement and
 * sans controls, square corners and 1px rules in the site's border colour.
 */
function EditorialDesign({ layout, wordmark }: DesignProps): ReactElement {
  const side = 88;
  return (
    <div
      style={{
        background: PAPER,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "space-between",
        padding: `${layout.padTop}px ${side}px ${layout.padBottom}px`,
        width: "100%",
      }}
    >
      <div style={{ borderBottom: `1px solid ${BORDER}`, display: "flex", paddingBottom: 40 }}>
        <img alt="" height={WORDMARK_HEIGHT} src={wordmark} width={WORDMARK_WIDTH} />
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            color: INK,
            display: "flex",
            flexDirection: "column",
            fontFamily: "Source Serif 4",
            fontSize: layout.statementSize,
            letterSpacing: -4,
            lineHeight: 0.98,
          }}
        >
          <div style={{ display: "flex" }}>My data,</div>
          <div style={{ color: PRIMARY, display: "flex", fontStyle: "italic" }}>my rules.</div>
        </div>
        <div
          style={{
            color: MUTED,
            display: "flex",
            fontFamily: "Source Serif 4",
            fontSize: 44,
            lineHeight: 1.4,
            marginTop: 64,
            maxWidth: 740,
          }}
        >
          {SHARE_CARD_COPY.subtext}
        </div>
      </div>

      <div
        style={{
          alignItems: "center",
          borderTop: `1px solid ${BORDER}`,
          display: "flex",
          justifyContent: "space-between",
          paddingTop: 40,
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: PRIMARY,
            border: `1px solid ${PRIMARY}`,
            color: ON_PRIMARY,
            display: "flex",
            fontFamily: "Inter",
            fontSize: 36,
            fontWeight: 700,
            padding: "26px 40px",
          }}
        >
          {SHARE_CARD_COPY.button}
        </div>
        <div style={{ color: MUTED, display: "flex", fontFamily: "Inter", fontSize: 36 }}>
          {SHARE_CARD_COPY.hashtag}
        </div>
      </div>
    </div>
  );
}

const DESIGNS = { editorial: EditorialDesign } as const;

export type ShareCardVariant = keyof typeof DESIGNS;
export const DEFAULT_SHARE_CARD_VARIANT: ShareCardVariant = "editorial";

export async function renderShareCard(
  format: ShareCardFormat,
  variant: ShareCardVariant = DEFAULT_SHARE_CARD_VARIANT
): Promise<ImageResponse> {
  const [interRegular, interBold, serifRegular, serifItalic] = await fonts;
  const Design = DESIGNS[variant];
  return new ImageResponse(<Design layout={LAYOUTS[format]} wordmark={wordmarkDataUri} />, {
    ...SHARE_CARD_FORMATS[format],
    fonts: [
      { data: interRegular, name: "Inter", style: "normal", weight: 400 },
      { data: interBold, name: "Inter", style: "normal", weight: 700 },
      { data: serifRegular, name: "Source Serif 4", style: "normal", weight: 400 },
      { data: serifItalic, name: "Source Serif 4", style: "italic", weight: 400 },
    ],
  });
}
