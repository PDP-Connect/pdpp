// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { cn } from "@/lib/utils.ts";

export interface DocsSidebarItem {
  active?: boolean;
  href: string;
  label: string;
}

export interface DocsSidebarSection {
  heading: string;
  items: DocsSidebarItem[];
}

export function DocsSidebar({ sections }: { sections: DocsSidebarSection[] }) {
  return (
    <aside className="hidden xl:sticky xl:top-[4.5rem] xl:block xl:self-start">
      <nav className="flex flex-col gap-5">
        {sections.map((section) => (
          <div className="flex flex-col gap-2" key={section.heading}>
            <div className="font-medium text-muted-foreground text-xs">{section.heading}</div>
            <ul className="flex flex-col gap-1">
              {section.items.map((item) => (
                <li key={`${section.heading}-${item.href}`}>
                  <Link
                    aria-current={item.active ? "page" : undefined}
                    className={cn(
                      "pdpp-label block py-1 transition-colors",
                      item.active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                    href={item.href}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
