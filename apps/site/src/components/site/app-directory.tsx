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

// Same card as the participate page: a 1px ring, so cards in a gap-px grid share borders.
const CARD = cn("flex flex-col gap-2 bg-background p-6", "shadow-[0_0_0_1px_var(--border)]");

function AppCard({ entry }: { entry: DirectoryEntry }) {
  return (
    <li className={cn(CARD, "max-w-none!")}>
      <div className="flex items-baseline justify-between gap-4">
        <Text as="h3" size="lede" weight="semi">
          {entry.name}
        </Text>
        {entry.tierLabel && (
          <Text as="span" className="shrink-0" color="subtle" family="mono" inline size="stamp">
            {entry.tierLabel}
          </Text>
        )}
      </div>
      {entry.headline && (
        <Text as="p" size="small" wrap="pretty">
          {entry.headline}
        </Text>
      )}
      {entry.labels && (
        <Text as="p" color="muted" size="small" wrap="pretty">
          {entry.labels}
        </Text>
      )}
      {entry.status && (
        <Text as="p" color="subtle" size="small" wrap="pretty">
          {entry.status}
        </Text>
      )}
      {entry.sourceUrl && (
        <Text as="p" className="mt-auto pt-2" size="small">
          <a
            aria-label={`Source code for the ${entry.name} connector on GitHub`}
            className="text-primary hover:text-foreground"
            href={entry.sourceUrl}
            rel="noopener"
            target="_blank"
          >
            Source on GitHub ↗
          </a>
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
        <ul className="grid grid-cols-1 gap-px md:grid-cols-2 xl:grid-cols-3">
          {shown.map((entry) => (
            <AppCard entry={entry} key={entry.id} />
          ))}
        </ul>
      )}

      {showsDevelopment && (
        <Text as="p" color="muted" size="small">
          Connectors marked In development may not work for everyone yet.
        </Text>
      )}
    </div>
  );
}
