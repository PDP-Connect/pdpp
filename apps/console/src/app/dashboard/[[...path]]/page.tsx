import { buttonVariants } from "@pdpp/brand-react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  title: "PDPP app route moved",
};

const REPAIR_LINKS = [
  { href: "/", label: "Open overview" },
  { href: "/sources", label: "Open sources" },
  { href: "/syncs", label: "Open syncs" },
  { href: "/notifications", label: "Set up notifications" },
] as const;

export default function StaleDashboardLaunchPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-5 px-6 py-16">
      <p className="pdpp-eyebrow text-muted-foreground/70 uppercase tracking-widest">PDPP</p>
      <h1 className="pdpp-heading text-foreground">This installed app opened an old route.</h1>
      <p className="pdpp-body text-muted-foreground">
        The owner console now uses clean routes like <code className="font-mono">/sources</code> and{" "}
        <code className="font-mono">/syncs</code>. Your browser or installed PWA may still be restoring the old{" "}
        <code className="font-mono">/dashboard</code> launch path.
      </p>
      <div className="flex flex-wrap gap-2">
        {REPAIR_LINKS.map((link, index) => (
          <Link
            className={buttonVariants({ variant: index === 0 ? "default" : "ghost", size: "sm" })}
            href={link.href}
            key={link.href}
          >
            {link.label}
          </Link>
        ))}
      </div>
      <p className="pdpp-caption text-muted-foreground">
        If the installed app keeps returning here, remove the PWA from Brave and install it again from{" "}
        <code className="font-mono">https://pdpp.vivid.fish/</code>. That clears stale launch metadata; it does not
        delete PDPP records.
      </p>
    </main>
  );
}
