// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Text } from "@/components/typography/text.tsx";
import { appName, type DirectoryEntry, searchDirectory } from "@/lib/app-directory.ts";
import { cn } from "@/lib/utils.ts";

// The app search on /apps.
//
// The server page joins the three published lists into `entries` and passes
// them down, so the page itself is static. This component only filters them as
// the visitor types. The query stays in this component: it is not sent
// anywhere, stored, or put in the URL.

const fieldClassName = cn(
  "w-full border border-border bg-background px-3 py-2",
  "font-sans text-[15px] text-foreground",
  "focus-visible:border-primary focus-visible:outline-none"
);

function countLine(count: number, searching: boolean): string {
  if (searching) {
    return `${count} ${count === 1 ? "result" : "results"}`;
  }
  return `${count} ${count === 1 ? "connector" : "connectors"}`;
}

function AppRow({ entry }: { entry: DirectoryEntry }) {
  return (
    <li className="flex max-w-none! flex-col gap-1.5 py-5 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Text as="h3" size="lede" weight="semi">
          {entry.name}
        </Text>
        <div className="flex items-baseline gap-4">
          {entry.tierLabel && (
            <Text as="span" color="subtle" family="mono" inline size="stamp">
              {entry.tierLabel}
            </Text>
          )}
          {entry.sourceUrl && (
            <Text
              aria-label={`Source code for the ${entry.name} connector on GitHub`}
              as="a"
              className="text-primary hover:text-primary-emphasis hover:underline hover:underline-offset-[3px]"
              family="mono"
              href={entry.sourceUrl}
              inline
              rel="noopener"
              size="stamp"
              target="_blank"
            >
              Source ↗
            </Text>
          )}
        </div>
      </div>
      {entry.headline && (
        <Text as="p" size="body" wrap="pretty">
          {entry.headline}
        </Text>
      )}
      {entry.labels && (
        <Text as="p" color="muted" size="body" wrap="pretty">
          {entry.labels}
        </Text>
      )}
      {entry.status && (
        <Text as="p" color="subtle" size="small" wrap="pretty">
          {entry.status}
        </Text>
      )}
    </li>
  );
}

export function PdppAppDirectory({ entries }: { entries: readonly DirectoryEntry[] }) {
  const [query, setQuery] = useState("");
  const [example, setExample] = useState<string | null>(null);

  // A random supported app as the example. Picked after hydration, so the
  // static HTML and the first client render agree.
  useEffect(() => {
    const supported = entries.filter((entry) => entry.tier === "supported").map((entry) => appName(entry.name));
    if (supported.length > 0) {
      setExample(supported[Math.floor(Math.random() * supported.length)] ?? null);
    }
  }, [entries]);
  const trimmed = query.trim();
  const shown = searchDirectory(entries, query);
  const showsDevelopment = shown.some((entry) => entry.tier === "development");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-[68ch] flex-col gap-2">
        <label className="sr-only" htmlFor="app-search">
          Search for an app
        </label>
        <input
          autoComplete="off"
          className={fieldClassName}
          id="app-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={example ? `Search for an app, for example ${example}` : "Search for an app"}
          type="search"
          value={query}
        />
        <Text aria-live="polite" as="p" color="subtle" family="mono" size="stamp">
          {countLine(shown.length, trimmed.length > 0)}
        </Text>
      </div>

      {shown.length === 0 ? (
        <div className="flex max-w-[68ch] flex-col gap-2">
          <Text as="p" size="body">
            Nothing for “{trimmed}” yet.
          </Text>
          <Text as="p" size="body">
            <Link className="text-primary hover:text-foreground" href="/principles">
              Ask for it when you sign the Principles
            </Link>
          </Text>
        </div>
      ) : (
        <div className="flex max-w-[68ch] flex-col gap-4">
          {shown.some((entry) => entry.kind === "connector") && (
            <Text as="p" color="muted" size="small" wrap="pretty">
              Each app below has an open-source connector that brings your data from it into PDPP. Its company has not
              signed the Principles or registered with PDPP unless the entry says so.
            </Text>
          )}
          <ul className="flex flex-col divide-y divide-border/60">
            {shown.map((entry) => (
              <AppRow entry={entry} key={entry.id} />
            ))}
          </ul>
        </div>
      )}

      {showsDevelopment && (
        <Text as="p" color="muted" size="small">
          Connectors marked In development may not work for everyone yet.
        </Text>
      )}
    </div>
  );
}
