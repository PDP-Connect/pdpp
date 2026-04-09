import Link from 'next/link';

export default function Home() {
  return (
    <main className="min-h-screen px-6 py-20 md:px-12">
      <div className="mx-auto flex max-w-5xl flex-col gap-12">
        <section className="flex flex-col gap-6">
          <span className="pdpp-eyebrow">PDPP</span>
          <div className="flex flex-col gap-4">
            <h1 className="max-w-4xl text-5xl font-semibold tracking-tight md:text-7xl">
              Personal Data Portability Protocol
            </h1>
            <p className="max-w-3xl text-lg leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
              One site for the protocol docs, the interactive reference implementation, and the shared design system.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/docs" className="rounded-full px-5 py-2.5 text-sm font-medium" style={{ background: 'var(--foreground)', color: 'var(--background)' }}>
              Read the Docs
            </Link>
            <Link href="/reference" className="rounded-full border px-5 py-2.5 text-sm font-medium" style={{ borderColor: 'var(--border)' }}>
              Open the Reference
            </Link>
            <Link href="/design" className="rounded-full border px-5 py-2.5 text-sm font-medium" style={{ borderColor: 'var(--border)' }}>
              Browse the Design System
            </Link>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          {[
            {
              href: '/docs/spec-core',
              title: 'Protocol Docs',
              body: 'Initial Fumadocs migration for the spec corpus, starting with the core protocol and collection profile.',
            },
            {
              href: '/reference',
              title: 'Reference App',
              body: 'The existing interactive reference is now part of the canonical web app rather than a separate deployment target.',
            },
            {
              href: '/design',
              title: 'Shared Design',
              body: 'Brand primitives are shared across docs and product surfaces through one CSS/token package.',
            },
          ].map((item) => (
            <Link
              key={item.title}
              href={item.href}
              className="rounded-3xl border p-6 transition-transform hover:-translate-y-0.5"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--card)' }}
            >
              <div className="mb-3 text-xl font-semibold tracking-tight">{item.title}</div>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
                {item.body}
              </p>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}
