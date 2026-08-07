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
    // Outer frame — interior rules are full-bleed to the lockup edge / col divider
    <div>
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
        Grid cells carry the rules (border-r / border-t), not padded inners —
        so every rule runs edge-to-edge and T-junctions meet. Measure stays on
        the copy stack only; never on the column shell (that inset the rules).
      */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] items-stretch max-lg:grid-cols-[minmax(0,1fr)]">
        {/* LHS */}
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex max-w-measure flex-col gap-5 pt-4 pb-5">
            {/* The h1 for `/`. The wordmark above is an image and the lockup's
                status stamp is chrome, so this line is the page's only heading. */}
            <Text as="h1" size="title" weight="medium">
              Personal Data Portability Protocol (PDPP) is an open protocol for scoped access to personal data.
            </Text>
            <Text className="opacity-60" size="title" weight="medium">
              A grant is how one person approves one application to read chosen records and fields, and a resource
              server enforces it on every request.
            </Text>
            <Text color="muted" size="body" wrap="balanced">
              It profiles{" "}
              <a href="https://oauth.net/2/" rel="noopener noreferrer" target="_blank">
                OAuth 2.0
              </a>{" "}
              and{" "}
              <a href="https://www.rfc-editor.org/info/rfc9396" rel="noopener noreferrer" target="_blank">
                RFC 9396
              </a>
              , the same pattern as{" "}
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
              <span>Implement PDPP</span>
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

        {/* RHS — fills the column on lg+; stacks under LHS below lg */}
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 p-5 max-lg:flex-none">
            <div
              aria-hidden="true"
              className="pointer-events-none min-h-0 w-full min-w-0 max-lg:h-[clamp(260px,36vh,380px)] lg:h-full lg:min-h-[clamp(260px,36vh,380px)]"
            >
              <PdppHeroWaterStill />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
