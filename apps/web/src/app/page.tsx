"use client";

import Link from "next/link";
import { Hero } from "@/components/Hero.tsx";
import { ReferenceApp } from "@/components/ReferenceApp.tsx";
import { ReferenceHeroProof } from "@/components/ReferenceHeroProof.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";

export default function Home() {
  return (
    <ReferenceApp
      currentLabel="Overview"
      hero={
        <Hero
          layout="cross"
          gradient="dual"
          size="splash"
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
          title={
            <>
              Granular access
              <br />
              to personal data
            </>
          }
          description={
            <>
              Clients request named records and fields.
              <br />
              Every response stays inside the grant.
            </>
          }
          actions={
            <div className="flex w-full flex-col gap-6">
              <div className="flex flex-wrap gap-2.5">
                <Link href="/docs" className={buttonVariants({ variant: "default", size: "lg" })}>
                  Read the docs
                </Link>
                <a href="#request" className={buttonVariants({ variant: "outline", size: "lg" })}>
                  See the flow
                </a>
              </div>
              <ReferenceHeroProof />
            </div>
          }
        />
      }
    />
  );
}
