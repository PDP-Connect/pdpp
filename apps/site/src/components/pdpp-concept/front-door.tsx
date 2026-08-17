// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { Button } from "@/components/pdpp-concept/button.tsx";
import { WordmarkIcon } from "@/components/pdpp-concept/icons.tsx";
import { Text } from "@/components/pdpp-concept/text.tsx";
import { cn } from "@/lib/utils.ts";
import { PdppHeroWaterStill } from "./hero-water-still.tsx";
import { SPEC_STATUS_STAMP } from "./spec-status.ts";

export function PdppFrontDoor() {
  return (
    // Outer frame — interior rules are full-bleed to the lockup edge / col divider.
    // data-slot marks this as DISPLAY copy, not a reading column, so the
    // .pdpp-doc reading measure does not apply here (see concept/components.css).
    <div data-slot="pdpp-front-door">
      {/* Brand lockup — full across */}
      <div className="flex flex-col gap-5 border-primary border-b pb-3.5 lg:pb-5">
        <div className="flex h-12 min-w-0 flex-wrap items-baseline justify-between gap-x-5 gap-y-3 text-primary max-md:h-auto max-md:flex-col max-md:items-start lg:pl-0.5">
          <WordmarkIcon className="block h-full w-auto shrink-0 max-md:h-10" />
          <Text
            caps
            className="translate-y-[-0.6em] max-md:translate-y-0"
            color="primary"
            family="mono"
            size="body"
            weight="normal"
          >
            {SPEC_STATUS_STAMP}
          </Text>
        </div>
      </div>

      {/*
        Two columns on xl+, stacked below. The split waits for xl because at
        lg the viz column immediately claims ~45% and the headline DROPPED from
        933px to 531px — a 43% cut, the worst in a seven-site reference sample
        (MCP 37%, Tailscale 6%, four with none). MCP, the closest analogue,
        splits at 1280; Tailscale, Kubernetes and Let's Encrypt never put a
        visual beside the copy at all. The only rule left is the lockup's
        border-b above — the interior rules and the box frame are gone, so
        nothing here needs to keep T-junctions meeting. The copy column takes
        its width from the grid track rather than a measure cap: at the 1080px
        page the 1fr track already lands inside the prose measure.
      */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] items-stretch max-xl:grid-cols-[minmax(0,1fr)]">
        {/* LHS */}
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex flex-col gap-5 pt-4 pb-5">
            {/* The h1 for `/`. The wordmark above is an image and the lockup's
                status stamp is chrome, so this line is the page's only heading. */}
            <Text as="h1" size="display" weight="medium">
              An open protocol for scoped access to personal data.
            </Text>
            <Text className="opacity-60" size="lede">
              Use your purchases, messages, workouts, and more in apps and with agents.
            </Text>
            <Text color="muted" size="body" wrap="balanced">
              PDPP profiles{" "}
              <a href="https://oauth.net/2/" rel="noopener noreferrer" target="_blank">
                OAuth 2.0
              </a>{" "}
              and{" "}
              <a href="https://www.rfc-editor.org/info/rfc9396" rel="noopener noreferrer" target="_blank">
                RFC 9396
              </a>
              , like{" "}
              <a href="https://www.smarthealthit.org/" rel="noopener noreferrer" target="_blank">
                SMART on FHIR
              </a>{" "}
              and{" "}
              <a href="https://www.openbanking.org.uk/" rel="noopener noreferrer" target="_blank">
                Open Banking
              </a>
              .
            </Text>
          </div>

          <div
            className={cn(
              "pt-5 pr-5",
              "flex flex-wrap items-center gap-3",
              "max-[460px]:flex-col max-[460px]:items-stretch"
            )}
          >
            <Button
              className="gap-2.5 rounded-[3px] px-4 py-3 font-normal"
              nativeButton={false}
              render={<Link href="/specification" />}
              variant="primary"
            >
              <span>Read the standard</span>
              <span aria-hidden="true" className="opacity-60">
                →
              </span>
            </Button>
            <Button
              className="gap-2.5 rounded-[3px] border-border-subtle px-4 py-3 font-normal text-foreground!"
              nativeButton={false}
              render={<Link href="/self-host" />}
              variant="secondary"
            >
              <span>Self-Host</span>
              <span aria-hidden="true" className="text-foreground-faint">
                →
              </span>
            </Button>
            <Button
              className="gap-2.5 rounded-[3px] border-border-subtle px-4 py-3 font-normal text-foreground!"
              nativeButton={false}
              render={<Link href="/participate" />}
              variant="secondary"
            >
              <span>Join the project</span>
              <span aria-hidden="true" className="text-foreground-faint">
                →
              </span>
            </Button>
          </div>
        </div>

        {/* RHS — shorter when stacked, full height beside the copy on xl+.

            Below xl this block sits UNDER the copy at full width, so its
            height is pure vertical cost: at 380px it pushed the fold well past
            the CTAs on a phone. Beside the copy on xl+ it costs nothing extra,
            because the copy column is taller than it is. Same columns and same
            drift at every width — only the height changes. */}
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="min-h-0 flex-1 p-5 max-xl:px-0">
            <div
              aria-hidden="true"
              className="pointer-events-none h-[clamp(160px,22vh,220px)] w-full min-w-0 xl:h-[clamp(260px,36vh,380px)]"
            >
              <PdppHeroWaterStill />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
