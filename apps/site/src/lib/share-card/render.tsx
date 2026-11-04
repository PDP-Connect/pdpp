// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { ReactElement } from "react";
import { SHARE_CARD_COPY, SHARE_CARD_FORMATS, type ShareCardFormat } from "./copy.ts";

// Brand values, as hex. Satori cannot parse oklch(), so each is the sRGB value of
// a token in packages/pdpp-brand/styles/tokens/primitive.css, or of the mark's own
// fill in apps/site/public/brand/pdpp-mark.svg. Re-derive them if a token moves.
const PAPER = "#fcfaf6"; // the mark's centre dot, oklch(0.985 0.005 85)
const INK = "#070707"; // --foreground, oklch(0.13 0 0)
const MUTED = "#4a4a4a"; // --muted-foreground (oklch(0.5 0 0)) darkened for small text on paper
const BLUE = "#007ae0"; // the mark's blue, oklch(0.58 0.18 253)
const BLUE_EMPHASIS = "#005bba"; // --primary-emphasis, oklch(0.48 0.172 253.7)
const COPPER = "#9c522e"; // the mark's copper, oklch(0.52 0.11 45)
const ON_BLUE = "#ffffff"; // --on-primary-emphasis, oklch(0.99 0 0)

/** One oklch() colour to sRGB hex (Oklab to linear sRGB to gamma), clamped to the gamut. */
function oklchToHex(lightness: number, chroma: number, hue: number): string {
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  const linear = [
    4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
    -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
    -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s,
  ];
  return `#${linear
    .map((value) => {
      const clamped = Math.min(1, Math.max(0, value));
      const encoded = clamped <= 0.003_130_8 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
      return Math.round(encoded * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/**
 * The renderer's SVG engine cannot parse oklch(), and paints such a fill black.
 * The mark file is embedded as it is on disk, geometry and colour values
 * unchanged; only the notation of each fill is rewritten to the same colour in hex.
 */
export function oklchFillsToHex(svg: string): string {
  return svg.replace(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/g, (_match, l: string, c: string, h: string) =>
    oklchToHex(Number(l), Number(c), Number(h))
  );
}

const ASSETS = join(process.cwd(), "assets", "share-card");
const MARK_PATH = join(process.cwd(), "public", "brand", "pdpp-mark.svg");

// Read once per process. The files ship with the repo; nothing is fetched.
const fonts = Promise.all([
  readFile(join(ASSETS, "Inter-Regular.ttf")),
  readFile(join(ASSETS, "Inter-Bold.ttf")),
  readFile(join(ASSETS, "SourceSerif4-Regular.ttf")),
  readFile(join(ASSETS, "SourceSerif4-It.ttf")),
]);
const markDataUri = readFile(MARK_PATH, "utf8").then(
  (svg) => `data:image/svg+xml;base64,${Buffer.from(oklchFillsToHex(svg)).toString("base64")}`
);

/** Per-format measurements. The design is the same; only the room around it changes. */
interface Layout {
  /** Space above and below the content; Stories keeps clear of the app's own header and reply bar. */
  padBottom: number;
  padTop: number;
  statementSize: number;
}

const LAYOUTS: Record<ShareCardFormat, Layout> = {
  feed: { padBottom: 96, padTop: 96, statementSize: 176 },
  story: { padBottom: 300, padTop: 260, statementSize: 192 },
};

interface DesignProps {
  layout: Layout;
  mark: string;
}

/**
 * The card's designs. Adding another is a new entry here and a new value of
 * `ShareCardVariant`; the route, sizes, fonts and copy do not change.
 */
function EditorialDesign({ layout, mark }: DesignProps): ReactElement {
  const side = 96;
  const MARK_SIZE = 176;
  return (
    <div
      style={{
        background: PAPER,
        backgroundImage:
          "radial-gradient(circle at 8% 4%, rgba(156,82,46,0.13), transparent 42%), radial-gradient(circle at 96% 98%, rgba(0,122,224,0.14), transparent 46%)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "space-between",
        padding: `${layout.padTop}px ${side}px ${layout.padBottom}px`,
        width: "100%",
      }}
    >
      {/* The file has 20% empty margin on the left; pull it back so the mark lines up with the text. */}
      <img alt="" height={MARK_SIZE} src={mark} style={{ marginLeft: -MARK_SIZE * 0.2 }} width={MARK_SIZE} />

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            color: INK,
            display: "flex",
            flexDirection: "column",
            fontFamily: "Source Serif 4",
            fontSize: layout.statementSize,
            letterSpacing: -5,
            lineHeight: 1.0,
          }}
        >
          <div style={{ display: "flex" }}>My data,</div>
          <div style={{ color: BLUE, display: "flex", fontStyle: "italic" }}>my rules.</div>
        </div>
        <div style={{ background: COPPER, display: "flex", height: 6, marginBottom: 44, marginTop: 56, width: 88 }} />
        <div
          style={{
            color: MUTED,
            display: "flex",
            fontFamily: "Inter",
            fontSize: 44,
            lineHeight: 1.36,
            maxWidth: 860,
          }}
        >
          {SHARE_CARD_COPY.subtext}
        </div>
      </div>

      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}>
        <div
          style={{
            alignItems: "center",
            background: BLUE_EMPHASIS,
            borderRadius: 20,
            color: ON_BLUE,
            display: "flex",
            fontFamily: "Inter",
            fontSize: 40,
            fontWeight: 700,
            padding: "28px 40px",
          }}
        >
          {SHARE_CARD_COPY.button}
        </div>
        <div style={{ color: COPPER, display: "flex", fontFamily: "Inter", fontSize: 40, fontWeight: 700 }}>
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
  const [[interRegular, interBold, serifRegular, serifItalic], mark] = await Promise.all([fonts, markDataUri]);
  const Design = DESIGNS[variant];
  return new ImageResponse(<Design layout={LAYOUTS[format]} mark={mark} />, {
    ...SHARE_CARD_FORMATS[format],
    fonts: [
      { data: interRegular, name: "Inter", style: "normal", weight: 400 },
      { data: interBold, name: "Inter", style: "normal", weight: 700 },
      { data: serifRegular, name: "Source Serif 4", style: "normal", weight: 400 },
      { data: serifItalic, name: "Source Serif 4", style: "italic", weight: 400 },
    ],
  });
}
