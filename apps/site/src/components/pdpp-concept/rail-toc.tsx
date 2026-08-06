// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useEffect, useRef, useState } from "react";
import { Text } from "@/components/pdpp-concept/text.tsx";
import { cn } from "@/lib/utils.ts";

export interface PdppRailTocItem {
  href: string;
  label: string;
}

export interface PdppRailTocProps {
  toc: readonly PdppRailTocItem[];
}

export function PdppRailToc({ toc }: PdppRailTocProps) {
  const [activeHref, setActiveHref] = useState<string | null>(null);
  const linksRef = useRef<readonly PdppRailTocItem[]>(toc);
  linksRef.current = toc;

  useEffect(() => {
    const ids = linksRef.current.map((item) => item.href.slice(1)).filter(Boolean);
    const elements = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) {
      return;
    }

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visible.add(entry.target.id);
          } else {
            visible.delete(entry.target.id);
          }
        }
        const firstVisible = ids.find((id) => visible.has(id));
        setActiveHref(firstVisible ? `#${firstVisible}` : null);
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 0 }
    );

    for (const el of elements) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <div className="pt-4" data-slot="pdpp-concept-rail-toc">
      <Text as="p" className="mb-2.5!" color="faint" intent="eyebrow">
        Contents
      </Text>
      <nav aria-label="Table of contents">
        <ol className="m-0 list-none p-0 font-sans text-[13px]">
          {toc.map((item) => {
            const active = activeHref === item.href;
            return (
              <li className="mb-[9px] leading-[1.35] last:mb-0" key={item.href}>
                <a
                  aria-current={active ? "location" : undefined}
                  className={cn(
                    "block border-b-0 no-underline",
                    active ? "font-medium text-teal" : "text-ink-soft hover:text-teal"
                  )}
                  href={item.href}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}
