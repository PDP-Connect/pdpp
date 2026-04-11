'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { siteNav } from '@pdpp/brand/chrome';

export function SiteHeader({ currentLabel }: { currentLabel: string }) {
  const pathname = usePathname();
  const isHome = pathname === '/';

  return (
    <div className="flex items-center gap-2">
      <Link href="/" className="flex items-center gap-2 shrink-0" aria-label="PDPP home">
        <div
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
          style={{ background: 'var(--primary)' }}
        >
          <span className="text-[9px] font-bold leading-none" style={{ color: 'var(--primary-foreground)' }}>
            P
          </span>
        </div>
        <span className="text-sm font-semibold tracking-tight" style={{ color: 'var(--foreground)' }}>
          PDPP
        </span>
      </Link>
      {isHome ? (
        // Reserved spacer keeps the nav anchored at the same x as on subpages.
        <span aria-hidden="true" style={{ minWidth: '9.5rem' }} />
      ) : (
        <>
          <span style={{ color: 'var(--muted-foreground)', opacity: 0.4, margin: '0 2px' }}>/</span>
          <span
            className="text-sm whitespace-nowrap"
            style={{ color: 'var(--muted-foreground)', minWidth: '8.5rem' }}
          >
            {currentLabel}
          </span>
        </>
      )}
      <nav className="hidden items-center gap-1 md:flex">
        {siteNav.map((item) => {
          const active = pathname === item.link || pathname.startsWith(`${item.link}/`);

          return (
            <Link
              key={item.link}
              href={item.link}
              className="rounded-full px-3 py-1.5 text-xs transition-colors"
              style={{
                backgroundColor: active ? 'var(--foreground)' : 'transparent',
                color: active ? 'var(--background)' : 'var(--muted-foreground)',
              }}
            >
              {item.text}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
