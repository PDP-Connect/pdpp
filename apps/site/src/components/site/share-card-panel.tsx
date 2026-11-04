// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Text } from "@/components/typography/text.tsx";
import {
  linkedInShareUrl,
  SHARE_CARD_ALT,
  SHARE_CARD_CAPTION,
  SHARE_CARD_FORMATS,
  type ShareCardFormat,
  shareCardPath,
  xIntentUrl,
} from "@/lib/share-card/copy.ts";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard.ts";
import { cn } from "@/lib/utils.ts";

const buttonClassName = cn(
  "w-fit cursor-pointer border border-primary px-5 py-2.5 font-sans text-[15px]",
  "bg-primary text-on-primary-emphasis hover:border-primary-emphasis hover:bg-primary-emphasis"
);
const quietButtonClassName = cn(
  "w-fit cursor-pointer border border-border px-5 py-2.5 font-sans text-[15px]",
  "text-foreground hover:border-primary hover:text-primary"
);

// A text control that sits at the end of the caption, so it reads as part of the line and not as a second button row.
const inlineCopyClassName = cn(
  // Plain inline (not flex), so "Copy" shares the caption's baseline; only the icon is nudged down.
  "ml-2 inline cursor-pointer whitespace-nowrap font-medium font-sans text-[13px]",
  "text-primary hover:text-primary-emphasis hover:underline hover:underline-offset-[3px]"
);

const CAPTION_COPY_LABELS = { copied: "Copied", failed: "Copy failed", idle: "Copy" } as const;
const CAPTION_COPY_NAMES = {
  copied: "Caption copied",
  failed: "Copy failed. Select the caption and copy it by hand.",
  idle: "Copy caption",
} as const;

const IMAGE_FILE_NAME = "pdpp-supporter-card.png";
const COPY_IMAGE_FAILED = "Your browser cannot copy images. Download it instead.";

function downloadName(format: ShareCardFormat): string {
  return format === "feed" ? IMAGE_FILE_NAME : "pdpp-supporter-card-story.png";
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Saves the card through a temporary link, so a post button can download and open a tab in one click. */
function downloadCard(format: ShareCardFormat): void {
  const anchor = document.createElement("a");
  anchor.href = shareCardPath(format);
  anchor.download = downloadName(format);
  anchor.click();
}

function openInNewTab(url: string): void {
  window.open(url, "_blank", "noopener");
}

async function fetchCardBlob(format: ShareCardFormat): Promise<Blob> {
  const response = await fetch(shareCardPath(format));
  if (!response.ok) {
    throw new Error(`Card request failed: ${response.status}`);
  }
  return await response.blob();
}

async function copyCaption(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(SHARE_CARD_CAPTION);
    return true;
  } catch {
    return false;
  }
}

/** A file with the card's name and type is enough to ask the browser whether it can share images. */
function browserCanShareImages(): boolean {
  if (typeof navigator.canShare !== "function") {
    return false;
  }
  const probe = new File([], IMAGE_FILE_NAME, { type: "image/png" });
  return navigator.canShare({ files: [probe] });
}

/**
 * Shown after a confirmed signing. The card is one image for every supporter
 * and carries no personal data, so nothing here is recorded or sent anywhere.
 */
export function ShareCardPanel() {
  const [status, setStatus] = useState("");
  const [canShareImages, setCanShareImages] = useState(false);
  const { copy: copyCaptionText, status: captionCopyStatus } = useCopyToClipboard();

  useEffect(() => {
    setCanShareImages(browserCanShareImages());
  }, []);

  async function onCopyImage() {
    try {
      // Hand the browser a pending blob so the copy keeps the click's permission (Safari needs this).
      await navigator.clipboard.write([new ClipboardItem({ "image/png": fetchCardBlob("feed") })]);
      setStatus("Image copied.");
    } catch {
      setStatus(COPY_IMAGE_FAILED);
    }
  }

  function onPostOnX() {
    // Open the tab first: a popup blocker only allows it inside the click itself.
    openInNewTab(xIntentUrl());
    downloadCard("feed");
    setStatus("Image downloaded. Attach it to your post on X.");
  }

  async function onPostOnLinkedIn() {
    openInNewTab(linkedInShareUrl());
    downloadCard("feed");
    const copied = await copyCaption();
    setStatus(
      copied
        ? "Image downloaded and caption copied. Paste the caption and attach the image on LinkedIn."
        : "Image downloaded. Copy the caption above and attach the image on LinkedIn."
    );
  }

  async function onShare() {
    try {
      const file = new File([await fetchCardBlob("feed")], IMAGE_FILE_NAME, { type: "image/png" });
      await navigator.share({ files: [file], text: SHARE_CARD_CAPTION });
    } catch (error) {
      if (!isAbort(error)) {
        setStatus("We could not share the image. Download it instead.");
      }
    }
  }

  return (
    <div className="flex flex-col gap-4" data-slot="pdpp-share-card-panel">
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
      <Text as="p" className="max-w-[34rem]" color="muted" size="small">
        {SHARE_CARD_CAPTION}
        <button
          aria-label={CAPTION_COPY_NAMES[captionCopyStatus]}
          className={inlineCopyClassName}
          onClick={() => copyCaptionText(SHARE_CARD_CAPTION)}
          type="button"
        >
          {captionCopyStatus === "copied" ? (
            <Check aria-hidden="true" className="mr-1 inline-block size-3.5 align-[-0.15em]" />
          ) : (
            <Copy aria-hidden="true" className="mr-1 inline-block size-3.5 align-[-0.15em]" />
          )}
          {CAPTION_COPY_LABELS[captionCopyStatus]}
        </button>
      </Text>
      <div className="flex flex-wrap gap-3">
        <a className={buttonClassName} download={downloadName("feed")} href={shareCardPath("feed")}>
          Download image
        </a>
        <a className={quietButtonClassName} download={downloadName("story")} href={shareCardPath("story")}>
          Download for Stories
        </a>
        <button className={quietButtonClassName} onClick={onCopyImage} type="button">
          Copy image
        </button>
        <button className={quietButtonClassName} onClick={onPostOnX} type="button">
          Post on X
        </button>
        <button className={quietButtonClassName} onClick={onPostOnLinkedIn} type="button">
          Post on LinkedIn
        </button>
        {canShareImages ? (
          <button className={quietButtonClassName} onClick={onShare} type="button">
            Share…
          </button>
        ) : null}
      </div>
      <Text aria-live="polite" as="p" color="muted" size="small">
        {status}
      </Text>
    </div>
  );
}
