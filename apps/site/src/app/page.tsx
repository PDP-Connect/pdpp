"use client";

import Link from "next/link";
import { Hero } from "@/components/hero.tsx";
import { ReferenceApp } from "@/components/reference-app.tsx";
import { ReferenceHeroProof } from "@/components/reference-hero-proof.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";

export default function Home() {
  return (
    <ReferenceApp
      currentLabel="Overview"
      hero={
        <Hero
          actions={
            <div className="flex w-full flex-col gap-6">
              <div className="flex flex-wrap gap-2.5">
                <Link className={buttonVariants({ variant: "default", size: "lg" })} href="/docs">
                  Read the docs
                </Link>
                <a className={buttonVariants({ variant: "outline", size: "lg" })} href="#request">
                  See the flow
                </a>
              </div>
              <ReferenceHeroProof />
            </div>
          }
          description={
            <>
              PDPP builds on OAuth with one model for personal data.
              <br />
              Owners decide which of their records and fields each app can read.
            </>
          }
          eyebrow={
            <span className="flex items-center gap-2">
              <span
                className="rounded px-2 py-0.5 font-mono text-xs"
                style={{
                  backgroundColor: "var(--primary-wash)",
                  color: "var(--primary)",
                  border: "1px solid var(--authorship-protocol-border)",
                }}
              >
                PDPP
              </span>
              <span className="font-mono text-xs tracking-wide" style={{ color: "var(--muted-foreground)" }}>
                v0.1.0 · Open reference
              </span>
            </span>
          }
          gradient="dual"
          layout="cross"
          size="splash"
          title={
            <>
              An open protocol for
              <br />
              portable, user-owned data
            </>
          }
        />
      }
    />
  );
}
