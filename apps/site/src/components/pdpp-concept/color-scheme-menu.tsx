// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { Check, ChevronUp } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverPortal,
  PopoverPositioner,
  PopoverTrigger,
} from "@/components/ui/popover.tsx";
import { cn } from "@/lib/utils.ts";
import { Button } from "./button.tsx";
import { conceptColorSchemeNames } from "./generated-color-scheme-names.ts";

const SCHEME_QUERY_KEY = "scheme";
const SCHEME_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const FIRST_CHARACTER_PATTERN = /^./;

type SchemeName = (typeof conceptColorSchemeNames)[number];

export function buildConceptSchemeHref(pathname: string, search: string, scheme: SchemeName | null): string {
  const params = new URLSearchParams(search);

  if (scheme) {
    params.set(SCHEME_QUERY_KEY, scheme);
  } else {
    params.delete(SCHEME_QUERY_KEY);
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function formatSchemeName(scheme: string): string {
  return scheme.replaceAll("-", " ").replace(FIRST_CHARACTER_PATTERN, (character) => character.toUpperCase());
}

function isSchemeName(value: string | null): value is SchemeName {
  return value !== null && SCHEME_NAME_PATTERN.test(value) && conceptColorSchemeNames.includes(value as SchemeName);
}

const SCHEME_OPTIONS: ReadonlyArray<{ label: string; value: SchemeName | null }> = [
  { label: "Original", value: null },
  ...conceptColorSchemeNames.map((scheme) => ({ label: formatSchemeName(scheme), value: scheme })),
];

export function ColorSchemeMenu() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedScheme = searchParams.get(SCHEME_QUERY_KEY);
  const activeScheme = isSchemeName(requestedScheme) ? requestedScheme : null;

  useEffect(() => {
    const root = document.documentElement;

    if (activeScheme) {
      root.dataset.pdppConceptScheme = activeScheme;
    } else {
      delete root.dataset.pdppConceptScheme;
    }

    return () => {
      delete root.dataset.pdppConceptScheme;
    };
  }, [activeScheme]);

  function selectScheme(scheme: SchemeName | null): void {
    router.replace(buildConceptSchemeHref(pathname, searchParams.toString(), scheme), { scroll: false });
  }

  return (
    <Popover>
      <PopoverTrigger className="text-[14px]!" render={<Button variant="footer" />}>
        Colour: {activeScheme ? formatSchemeName(activeScheme) : "Original"}
        <ChevronUp data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverPositioner align="end" side="top" sideOffset={8}>
          <PopoverPopup className="min-w-44 border-on-primary-emphasis/30 bg-primary-emphasis p-1 text-on-primary-emphasis">
            <fieldset className="m-0 flex flex-col gap-0.5 border-0 p-0">
              <legend className="sr-only">Colour scheme</legend>
              {SCHEME_OPTIONS.map((option) => {
                const isActive = option.value === activeScheme;
                return (
                  <PopoverClose
                    key={option.value ?? "original"}
                    render={
                      <Button
                        aria-current={isActive ? "true" : undefined}
                        className={cn(
                          "w-full justify-between border-transparent px-3 text-[14px]!",
                          isActive && "bg-on-primary-emphasis/10"
                        )}
                        onClick={() => selectScheme(option.value)}
                        variant="footer"
                      />
                    }
                  >
                    {option.label}
                    {isActive ? <Check data-icon="inline-end" /> : null}
                  </PopoverClose>
                );
              })}
            </fieldset>
          </PopoverPopup>
        </PopoverPositioner>
      </PopoverPortal>
    </Popover>
  );
}
