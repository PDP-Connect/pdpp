import Link from "next/link";
import { cn } from "@/lib/utils.ts";

export interface OpenSpecSidebarItem {
  href: string;
  label: string;
  active?: boolean;
}

export interface OpenSpecSidebarSection {
  heading: string;
  items: OpenSpecSidebarItem[];
}

export function OpenSpecSidebar({ sections }: { sections: OpenSpecSidebarSection[] }) {
  return (
    <aside className="hidden xl:sticky xl:top-[4.5rem] xl:block xl:self-start">
      <nav className="flex flex-col gap-5">
        {sections.map((section) => (
          <div key={section.heading} className="flex flex-col gap-2">
            <div className="font-medium text-muted-foreground text-xs">{section.heading}</div>
            <ul className="flex flex-col gap-1">
              {section.items.map((item) => (
                <li key={`${section.heading}-${item.href}`}>
                  <Link
                    href={item.href}
                    aria-current={item.active ? "page" : undefined}
                    className={cn(
                      "pdpp-label block py-1 transition-colors",
                      item.active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
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
