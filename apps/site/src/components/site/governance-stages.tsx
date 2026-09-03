// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Text } from "@/components/typography/text.tsx";
import { cn } from "@/lib/utils.ts";

// The four-stage governance diagram, built from components rather than shipped
// as an image.
//
// It is a diagram in the sense that matters — the reader sees four stages in
// order, each with when it starts and who holds authority — but it is text, so
// it reflows on a phone, respects the reader's theme, is selectable and
// searchable, and reads correctly aloud. An exported picture of this would be
// none of those things and would go stale the first time a date moved.
//
// The connector chevrons are aria-hidden: "→" announced between every stage is
// noise, and the ordered list already carries the sequence.

interface Stage {
  authority: string;
  body: string;
  name: string;
  when: string;
}

const STAGES: readonly Stage[] = [
  {
    when: "Pre · now, to 15 Oct",
    name: "Public comment",
    authority: "The maintainers",
    body: "The specification and Part A are frozen while people comment, the Principles are published, and you can sign now. This stage ends on 15 October.",
  },
  {
    when: "Phase 1 · from 15 Oct",
    name: "Launch",
    authority: "The maintainers",
    body: "The maintainers run things. Supporters can sign, but nobody can be verified until the review committee is named.",
  },
  {
    when: "Phase 2 · from Nov 2026",
    name: "Interim",
    authority: "Interim technical committee",
    body: "Five people, at least three with no connection to Vana or Open Data Labs, chosen on published criteria and not removable by the maintainers. They review every application for verified status in public and give a decision with reasons, which the maintainers act on. Verification opens at this point.",
  },
  {
    when: "Phase 3 · from 2027",
    name: "Full",
    authority: "Elected steering committee",
    body: "Partners elect a five-seat steering committee, one organisation one vote, with the Chair elected directly. The steering committee is the only body that can change the specification or grant a status, and it does both by majority vote. It appoints a technical committee, which reviews every application and every proposed change in public and recommends. The Chair records the vote and merges. This starts at 100 Partners or on 15 October 2027, whichever comes first, and not before 15 April 2027. Full detail is in Part B of the governance document.",
  },
];

export function PdppGovernanceStages({ className }: { className?: string }) {
  return (
    <div className={className}>
      <ol className="m-0 grid list-none grid-cols-1 gap-px p-0 md:grid-cols-2 xl:grid-cols-4">
        {STAGES.map((stage) => (
          <li className={cn("flex flex-col gap-2 bg-background p-5", "shadow-[0_0_0_1px_var(--border)]")} key={stage.name}>
            <Text as="p" color="primary" family="mono" size="stamp">
              {stage.when}
            </Text>
            <Text as="h3" size="lede" weight="semi">
              {stage.name}
            </Text>
            <Text as="p" color="subtle" size="stamp">
              {stage.authority}
            </Text>
            <Text as="p" color="muted" size="small" wrap="pretty">
              {stage.body}
            </Text>
          </li>
        ))}
      </ol>

      <div className="mt-10 flex max-w-[68ch] flex-col gap-3">
        <Text as="h3" size="lede" weight="semi">
          How decisions are made once the steering committee exists
        </Text>
        <Text as="p" color="muted" size="body" wrap="pretty">
          Before the steering committee exists, the interim technical committee recommends and the maintainers merge on
          that recommendation with no discretion. The shape is the same; only the body that votes is missing.
        </Text>
      </div>
    </div>
  );
}
