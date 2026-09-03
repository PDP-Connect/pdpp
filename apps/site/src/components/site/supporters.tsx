// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Text } from "@/components/typography/text.tsx";
import type { PublicSupporter } from "@/lib/public-supporters.ts";
import { cn } from "@/lib/utils.ts";

// The public register of Supporters.
//
// The prototype shows six example rows and a "[ 247 ] signatories" counter,
// labelled in the design as layout-only. Those are NOT rendered: the site
// ships supporters.json as an empty array, and a page that shows invented
// signatories is a page that has published a false register. The empty state
// below is what a reader sees until the first real signature lands.
//
// SHAPE: the table receives only the five public fields. The private store
// holds email, the signatory's name and role, and the consent flags; none of
// them have a route to this component, because the publish script never writes
// them into the public register. See docs/registers.md.

const CELL = "px-3 py-2.5 text-left align-top";

export function PdppSupportersTable({ supporters }: { supporters: readonly PublicSupporter[] }) {
  if (supporters.length === 0) {
    return (
      <div className="border border-border p-6" data-slot="pdpp-supporters-empty">
        <Text as="p" color="muted" size="body">
          No signatories are listed yet. The register is published here as soon as the first signature is confirmed.
        </Text>
      </div>
    );
  }

  return (
    // Wide tables scroll inside their own scrollport rather than pushing the
    // page sideways.
    <div className="overflow-x-auto border border-border">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-border border-b">
            {["Signatory", "Type", "Country", "Version", "Signed"].map((heading) => (
              <th className={cn(CELL, "font-normal")} key={heading} scope="col">
                <Text as="span" color="subtle" inline size="stamp">
                  {heading}
                </Text>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {supporters.map((supporter) => (
            <tr
              className="border-border/60 border-b last:border-b-0"
              key={`${supporter.publicName}-${supporter.signedOn}`}
            >
              <td className={CELL}>
                <Text as="span" inline size="small">
                  {supporter.publicName}
                </Text>
              </td>
              <td className={CELL}>
                <Text as="span" color="muted" inline size="small">
                  {supporter.type}
                </Text>
              </td>
              <td className={CELL}>
                <Text as="span" color="muted" inline size="small">
                  {supporter.country}
                </Text>
              </td>
              <td className={CELL}>
                <Text as="span" color="muted" family="mono" inline size="small">
                  {supporter.principlesVersion}
                </Text>
              </td>
              <td className={CELL}>
                <Text as="span" color="muted" family="mono" inline size="small">
                  {supporter.signedOn}
                </Text>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
