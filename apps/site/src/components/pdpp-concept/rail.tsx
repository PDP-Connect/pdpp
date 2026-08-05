// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useEffect, useRef, useState } from "react";

export interface PdppRailTocItem {
  href: string;
  label: string;
}

export interface PdppRailProps {
  governance?: string;
  toc: readonly PdppRailTocItem[];
}

// Ports the concept's rail (styles.css .rail/.toc, site.js's TOC IntersectionObserver
// and <960px disclosure collapse) to a React component. Participate/self-host/home
// render .pdpp-doc alone today because no component filled this slot — the CSS
// (.pdpp-rail, .pdpp-toc, .pdpp-rail__meta) already exists in pdpp-concept.css and
// only needed a renderer.
export function PdppRail({ governance, toc }: PdppRailProps) {
  const [activeHref, setActiveHref] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const linksRef = useRef<readonly PdppRailTocItem[]>(toc);
  linksRef.current = toc;

  useEffect(() => {
    // Matches the .pdpp-page rail-stacking breakpoint in pdpp-concept.css
    // (720px), not the concept's own 959px — the two sites collapse to a
    // single column at different widths, and this must track the PR's own.
    const narrow = window.matchMedia("(max-width: 720px)");
    const sync = (mq: MediaQueryList | MediaQueryListEvent) => setOpen(!mq.matches);
    sync(narrow);
    narrow.addEventListener("change", sync);
    return () => narrow.removeEventListener("change", sync);
  }, []);

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
    <aside aria-label="Document apparatus" className="pdpp-rail">
      {governance ? (
        <div className="pdpp-rail__block">
          <dl className="pdpp-rail__meta">
            <div>
              <dt>Governance</dt>
              <dd>{governance}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      <details className="pdpp-toc-details" onToggle={(event) => setOpen(event.currentTarget.open)} open={open}>
        <summary>Contents</summary>
        <nav aria-label="Table of contents" className="pdpp-toc">
          <ol>
            {toc.map((item) => (
              <li key={item.href}>
                <a aria-current={activeHref === item.href ? "location" : undefined} href={item.href}>
                  {item.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </details>
    </aside>
  );
}
