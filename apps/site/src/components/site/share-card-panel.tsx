// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useState } from "react";
import { Text } from "@/components/typography/text.tsx";
import {
  SHARE_CARD_ALT,
  SHARE_CARD_FORMATS,
  SHARE_CARD_LINK,
  type ShareCardFormat,
  shareCardPath,
} from "@/lib/share-card/copy.ts";
import { cn } from "@/lib/utils.ts";

const buttonClassName = cn(
  "w-fit cursor-pointer border border-primary px-5 py-2.5 font-sans text-[15px]",
  "bg-primary text-on-primary-emphasis hover:border-primary-emphasis hover:bg-primary-emphasis"
);
const quietButtonClassName = cn(
  "w-fit cursor-pointer border border-border px-5 py-2.5 font-sans text-[15px]",
  "text-foreground hover:border-primary hover:text-primary"
);

type ShareState = "idle" | "shared" | "copied" | "failed";

const SHARE_MESSAGES: Record<Exclude<ShareState, "idle">, string> = {
  copied: "Link copied.",
  failed: "We could not share or copy the link. Download the image instead.",
  shared: "Shared.",
};

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function shareOrCopy(): Promise<ShareState | "cancelled"> {
  try {
    const response = await fetch(shareCardPath("feed"));
    const file = new File([await response.blob()], "pdpp-supporter-card.png", { type: "image/png" });
    if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], url: SHARE_CARD_LINK });
      return "shared";
    }
  } catch (error) {
    if (isAbort(error)) {
      return "cancelled";
    }
    // Fall through to the link: a failed image fetch or share should not leave the supporter with nothing.
  }
  try {
    await navigator.clipboard.writeText(SHARE_CARD_LINK);
    return "copied";
  } catch {
    return "failed";
  }
}

function downloadName(format: ShareCardFormat): string {
  return `pdpp-supporter-card-${format}.png`;
}

/**
 * Shown after a confirmed signing. The card is one image for every supporter
 * and carries no personal data, so nothing here is recorded or sent anywhere.
 */
export function ShareCardPanel() {
  const [state, setState] = useState<ShareState>("idle");

  async function onShare() {
    const result = await shareOrCopy();
    setState(result === "cancelled" ? "idle" : result);
  }

  return (
    <div className="flex flex-col gap-4 border border-border p-4" data-slot="pdpp-share-card-panel">
      <Text as="p" size="body">
        Share your support.
      </Text>
      <img
        alt={SHARE_CARD_ALT}
        className="w-full max-w-[22rem] border border-border"
        height={SHARE_CARD_FORMATS.feed.height}
        src={shareCardPath("feed")}
        width={SHARE_CARD_FORMATS.feed.width}
      />
      <div className="flex flex-wrap gap-3">
        <button className={buttonClassName} onClick={onShare} type="button">
          Share
        </button>
        <a className={quietButtonClassName} download={downloadName("feed")} href={shareCardPath("feed")}>
          Download for feed
        </a>
        <a className={quietButtonClassName} download={downloadName("story")} href={shareCardPath("story")}>
          Download for Stories
        </a>
      </div>
      <Text aria-live="polite" as="p" color="muted" size="small">
        {state === "idle" ? "" : SHARE_MESSAGES[state]}
      </Text>
    </div>
  );
}
