import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { SiteHeader } from "@/components/site-header.tsx";
import { baseOptions } from "@/lib/docs-shared.tsx";
import { source } from "@/lib/docs-source.ts";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="pdpp-docs-shell">
      <header
        className="sticky top-0 z-40 flex h-12 items-center gap-3 px-5 md:px-6"
        style={{
          backgroundColor: "var(--background)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <SiteHeader currentLabel="Docs" showThemeToggle={false} />
        <div className="flex-1" />
        <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.5 }}>
          v0.1.0
        </span>
      </header>
      <DocsLayout sidebar={{ collapsible: false }} tree={source.getPageTree()} {...baseOptions()}>
        {children}
      </DocsLayout>
    </div>
  );
}
