// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { Button } from "@/components/pdpp-concept/button.tsx";
import { PdppHeroWater } from "@/components/pdpp-concept/hero-water.tsx";
import { WordmarkIcon } from "@/components/pdpp-concept/icons.tsx";
import { SPEC_STATUS_STAMP } from "@/components/pdpp-concept/spec-status.ts";
import { Text } from "@/components/pdpp-concept/text.tsx";
import { cn } from "@/lib/utils.ts";

export function PdppFrontDoor() {
  return (
    // Outer frame — all interior rules are full-bleed to this edge / the col divider
    <div className="border-2">
      {/* Brand lockup — full across */}
      <div className="flex flex-col gap-5 border-b p-5 pt-4">
        <div className="flex h-12 min-w-0 flex-wrap items-center gap-5">
          <WordmarkIcon className="block h-full w-auto shrink-0" />
          <hr className="h-full w-px bg-muted-foreground" />
          <Text as="h1" className="min-w-0 text-[44px] leading-none" size="display" weight="medium">
            Personal Data Portability Protocol
          </Text>
        </div>
        <Text color="muted" family="mono" size="stamp" weight="normal">
          {SPEC_STATUS_STAMP}
        </Text>
      </div>

      {/*
        Grid cells carry the rules (border-r / border-t), not padded inners —
        so every rule runs edge-to-edge and T-junctions meet. Measure stays on
        the copy stack only; never on the column shell (that inset the rules).
      */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] items-stretch max-[1200px]:grid-cols-[minmax(0,1fr)]">
        {/* LHS */}
        <div className="flex min-h-0 min-w-0 flex-col border-r max-[1200px]:border-r-0 max-[1200px]:border-b">
          <div className="flex max-w-measure flex-col gap-5 p-5 pt-4">
            <Text size="deck">An open protocol for scoped access to personal data.</Text>
            <Text className="opacity-60" size="deck">
              A grant is how one person approves one application to read chosen records and fields, and a resource
              server enforces it on every request.
            </Text>
            <Text color="muted" size="body">
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
              "mt-auto border-t p-5",
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
              className="min-w-0 flex-1 justify-between gap-2.5 rounded-[3px] border-border-subtle px-4 py-3 font-normal text-foreground!"
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

        {/* RHS — caption above the viz so the LHS CTA foot isn't mirrored */}
        <div className="flex min-h-0 flex-col">
          <div className="border-b p-5 text-center">
            <Text
              align="center"
              caps
              className="whitespace-normal! mx-auto max-w-[36ch]"
              color="foreground"
              family="mono"
              size="stamp"
            >
              Sleep scores · artists played · your conversations
            </Text>
          </div>
          <div className="min-h-0 flex-1 p-5">
            <PdppHeroWater />
          </div>
        </div>
      </div>
    </div>
  );
}
