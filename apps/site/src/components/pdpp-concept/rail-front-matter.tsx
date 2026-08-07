// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { GITHUB_REPO_URL } from "@/components/pdpp-concept/site-facts.ts";

export interface PdppRailFrontMatterProps {
  date: string;
  editors: readonly string[];
  status: string;
  version: string;
}

const githubDisplayText = GITHUB_REPO_URL.replace(/^https?:\/\//, "");

function RailMetaRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="block p-0 first:[&_dt]:mt-0">
      <dt className="mt-4 font-mono text-[12px] text-muted-foreground uppercase tracking-[0.04em]">{label}</dt>
      <dd className="mt-0.5 font-serif text-base text-foreground lining-nums tabular-nums">{children}</dd>
    </div>
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
        <RailMetaRow label="Source">
          <a
            className="link-prose font-sans text-[13px] no-underline"
            href={GITHUB_REPO_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            {githubDisplayText}
          </a>
        </RailMetaRow>
      </dl>
    </div>
  );
}
