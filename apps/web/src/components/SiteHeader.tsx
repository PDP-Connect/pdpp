'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { siteNav } from '@pdpp/brand/chrome';

export function SiteHeader({ currentLabel }: { currentLabel: string }) {
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 shrink-0">
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
      </div>
      <span style={{ color: 'var(--muted-foreground)', opacity: 0.4, margin: '0 2px' }}>/</span>
      <span className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
        {currentLabel}
      </span>
      <nav className="ml-4 hidden items-center gap-1 md:flex">
        {siteNav.map((item) => {
          const active = item.link === '/' ? pathname === '/' : pathname === item.link || pathname.startsWith(`${item.link}/`);

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
