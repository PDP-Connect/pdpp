// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { siteNav } from "@pdpp/brand/chrome";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function PdppConceptMasthead() {
  const pathname = usePathname();

  return (
    <header className="pdpp-masthead">
      <div className="pdpp-masthead__inner">
        <div className="pdpp-masthead__wordmark-line">
          <Link className="pdpp-wordmark" href="/">
            PDPP
          </Link>
          <span className="pdpp-masthead__label">Personal Data Portability Protocol</span>
        </div>
        <nav aria-label="Primary" className="pdpp-nav">
          {siteNav.map((item) => {
            const active = pathname === item.link || pathname.startsWith(`${item.link}/`);
            return (
              <Link aria-current={active ? "page" : undefined} href={item.link} key={item.link}>
                {item.text}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
