'use client';

import Link from 'next/link';
import { ReferenceApp } from '@/components/ReferenceApp';
import { ReferenceHeroProof } from '@/components/ReferenceHeroProof';
import { Hero } from '@/components/Hero';
import { buttonVariants } from '@/components/ui/button';

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
                className="font-mono text-xs px-2 py-0.5 rounded"
                style={{
                  backgroundColor: 'var(--primary-wash)',
                  color: 'var(--primary)',
                  border: '1px solid oklch(0.580 0.172 253.7 / 0.15)',
                }}
              >
                PDPP
              </span>
              <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
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
              <br />Every response stays inside the grant.
            </>
          }
          actions={
            <div className="flex w-full flex-col gap-6">
              <div className="flex flex-wrap gap-2.5">
                <Link href="/docs" className={buttonVariants({ variant: 'default', size: 'lg' })}>
                  Read the docs
                </Link>
                <a href="#request" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
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
