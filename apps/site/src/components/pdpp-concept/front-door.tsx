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
    <div
      className={cn(
        "flex flex-col gap-7 pt-[clamp(32px,1.5rem+2.4vw,56px)]",
        // "[border-bottom:var(--pdpp-concept-rule)]",
        // Rhythm on the stack, not mb-* on each Text — zero .pdpp-concept p bottom margin
        "[&_[data-slot=pdpp-concept-text]]:mb-0!"
      )}
    >
      <div className="space-y-5">
        {/* Brand lockup — full across; title shares the mark's line */}
        <div className="flex h-12 min-w-0 flex-wrap items-center gap-5">
          <WordmarkIcon className="block h-full w-auto shrink-0" />
          <hr className="h-full w-px bg-ink-soft" />
          <Text as="h1" className="min-w-0 text-[44px] leading-none" intent="display" weight="medium">
            Personal Data Portability Protocol
          </Text>
        </div>
        <hr className="mb-2" />
        <Text className="tracking-[0.04em]" color="soft" intent="stamp" mono weight="normal">
          {SPEC_STATUS_STAMP}
        </Text>
      </div>

      {/* Pitch + figure — same 1 / 0.85 grid as before; collapses under 1200px */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] items-start gap-12 max-[1200px]:block">
        <div className="flex min-w-0 max-w-measure flex-col gap-7">
          <div className="space-y-5">
            <Text intent="deck">An open protocol for scoped access to personal data.</Text>
            <Text intent="lede">
              A grant is how one person approves one application to read chosen records and fields, and a resource
              server enforces it on every request.
            </Text>
            <Text color="soft" intent="lede">
              Ninety days of sleep scores, the artists you played, your own conversations.
            </Text>
          </div>

          <div className="space-y-3">
            <Text color="soft" intent="body">
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

          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 max-[460px]:flex-col max-[460px]:items-stretch max-[460px]:[&_[data-slot=pdpp-concept-button]]:justify-center">
            <Button nativeButton={false} render={<Link href="/specification" />} variant="primary">
              Read the specification
            </Button>
            <Button nativeButton={false} render={<Link href="/self-host" />} variant="secondary">
              Self-host it
            </Button>
            <Button nativeButton={false} render={<Link href="/participate" />} variant="quiet">
              Participate
            </Button>
          </div>
        </div>

        <PdppHeroWater />
      </div>
    </div>
  );
}
