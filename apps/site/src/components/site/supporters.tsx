// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import path from "node:path";
import { Text } from "@/components/typography/text.tsx";
import { cn } from "@/lib/utils.ts";

// The public register of Supporters.
//
// The prototype shows six example rows and a "[ 247 ] signatories" counter,
// labelled in the design as layout-only. Those are NOT rendered: the site
// ships supporters.json as an empty array, and a page that shows invented
// signatories is a page that has published a false register. The empty state
// below is what a reader sees until the first real signature lands.
//
// SHAPE: this file is the only consumer of supporters.json, and it reads ONLY
// the five public fields. The private store holds email, the signatory's name
// and role, and the consent flags; none of them have a route to this
// component, because the publish script never writes them into the file this
// reads. See docs/registers.md.

export interface PublicSupporter {
  country: string;
  principlesVersion: string;
  /** First name and last initial for individuals, organisation name otherwise. */
  publicName: string;
  signedOn: string;
  type: string;
}

// Read at build time from the public JSON. A fetch at request time would put a
// network hop in front of a file that ships in the repo, and would 500 the
// page when it failed; a missing or malformed file here degrades to the empty
// state, which is the honest rendering when the register cannot be read.
export async function readPublicSupporters(): Promise<readonly PublicSupporter[]> {
  try {
    const file = path.join(process.cwd(), "public", "principles", "supporters.json");
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as PublicSupporter[]) : [];
  } catch {
    return [];
  }
}

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
