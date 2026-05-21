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
              Clients request named records and fields.
              <br />
              Every response stays inside the grant.
            </>
          }
          eyebrow={
            <span className="flex items-center gap-2">
              <span
                className="rounded px-2 py-0.5 font-mono text-xs"
                style={{
                  backgroundColor: "var(--primary-wash)",
                  color: "var(--primary)",
                  border: "1px solid oklch(0.580 0.172 253.7 / 0.15)",
                }}
              >
                PDPP
              </span>
              <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                v0.1.0 · Open reference
              </span>
            </span>
          }
          gradient="dual"
          layout="cross"
          size="splash"
          title={
            <>
              Granular access
              <br />
              to personal data
            </>
          }
        />
      }
    />
  );
}
