import type { ReactNode } from "react";
import { SiteHeader } from "@/components/site-header.tsx";

export default function ReferenceLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header
        className="sticky top-0 z-40 flex h-12 items-center px-5 md:px-6"
        style={{
          backgroundColor: "var(--background)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <SiteHeader currentLabel="Host your own" />
      </header>
      {children}
    </div>
  );
}
