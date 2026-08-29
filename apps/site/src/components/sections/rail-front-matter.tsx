// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { pdppRailLabelClassName } from "@/components/sections/rail-section-label.tsx";
import { GITHUB_REPO_URL, repoBlobUrl } from "@/lib/site-facts.ts";
import { cn } from "@/lib/utils.ts";

export interface PdppRailFrontMatterProps {
  date: string;
  editors: readonly string[];
  status: string;
  version: string;
}

export interface PdppRailGovernanceFrontMatterProps {
  circulated: string;
  formalReview: string;
  programmeLive: string;
  status: string;
}

function RailMetaRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="block p-0 first:[&_dt]:mt-0">
      <dt className={cn("mt-4", pdppRailLabelClassName)}>{label}</dt>
      <dd className="mt-0.5 font-serif text-base text-foreground lining-nums tabular-nums">{children}</dd>
    </div>
  );
}

function RailSourceRow({ href }: { href: string }) {
  return (
    <RailMetaRow label="Source">
      <a className="hover:text-primary" href={href} rel="noopener noreferrer" target="_blank">
        View on GitHub
      </a>
    </RailMetaRow>
  );
}

/** Specification rail banner: VERSION / STATUS / DATE / EDITORS / SOURCE. */
export function PdppRailFrontMatter({ date, editors, status, version }: PdppRailFrontMatterProps) {
  return (
    <div className="mb-10 text-[13px] text-muted-foreground leading-normal" data-slot="pdpp-rail-front-matter">
      <dl className="m-0">
        <RailMetaRow label="Version">{version}</RailMetaRow>
        <RailMetaRow label="Status">{status}</RailMetaRow>
        <RailMetaRow label="Date">{date}</RailMetaRow>
        <RailMetaRow label="Editors">
          {editors.map((editor) => (
            <span className="block [&+&]:mt-px" key={editor}>
              {editor}
            </span>
          ))}
        </RailMetaRow>
        <RailSourceRow href={GITHUB_REPO_URL} />
      </dl>
    </div>
  );
}

/**
 * Governance rail banner: STATUS / CIRCULATED / FORMAL REVIEW / PROGRAMME
 * LIVE / SOURCE. No Version and no Editors row — the programme document isn't
 * versioned like the specification, and it is amended by a vote of Partners
 * rather than maintained day to day (see MAINTAINERS.md).
 */
export function PdppRailGovernanceFrontMatter({
  circulated,
  formalReview,
  programmeLive,
  status,
}: PdppRailGovernanceFrontMatterProps) {
  return (
    <div className="mb-10 text-[13px] text-muted-foreground leading-normal" data-slot="pdpp-rail-front-matter">
      <dl className="m-0">
        <RailMetaRow label="Status">{status}</RailMetaRow>
        <RailMetaRow label="Circulated">{circulated}</RailMetaRow>
        <RailMetaRow label="Formal review">{formalReview}</RailMetaRow>
        <RailMetaRow label="Programme live">{programmeLive}</RailMetaRow>
        <RailSourceRow href={repoBlobUrl("GOVERNANCE.md")} />
      </dl>
    </div>
  );
}
