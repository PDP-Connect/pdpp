/**
 * Seed data for the Gmail connector demo.
 * Simulates realistic email metadata without scraping or real credentials.
 * Email bodies are never stored — just headers and metadata (subject, from, date, labels).
 */

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

export const SEED_GMAIL_THREADS = [
  // ── Commerce ──────────────────────────────────────────────────────────────
  { id: 'g001', subject: 'Your order has shipped — #13849', from: 'no-reply@amazon.com',      from_name: 'Amazon',             labels: ['inbox', 'commerce'], received_at: daysAgo(1),  thread_count: 2 },
  { id: 'g002', subject: 'Your receipt from Stripe',        from: 'receipts@stripe.com',       from_name: 'Stripe',             labels: ['inbox', 'commerce'], received_at: daysAgo(3),  thread_count: 1 },
  { id: 'g003', subject: 'Your Figma invoice #INV-2841',    from: 'billing@figma.com',         from_name: 'Figma',              labels: ['commerce'],          received_at: daysAgo(8),  thread_count: 1 },
  { id: 'g004', subject: 'New order confirmation — Vercel', from: 'billing@vercel.com',        from_name: 'Vercel',             labels: ['commerce'],          received_at: daysAgo(12), thread_count: 1 },
  { id: 'g005', subject: 'Your GitHub subscription',        from: 'billing@github.com',        from_name: 'GitHub',             labels: ['commerce'],          received_at: daysAgo(22), thread_count: 2 },

  // ── Work / collaboration ───────────────────────────────────────────────────
  { id: 'g006', subject: 'PR review: feat/pdpp-consent-flow', from: 'noreply@github.com',      from_name: 'GitHub',             labels: ['inbox', 'work'],     received_at: daysAgo(0),  thread_count: 5 },
  { id: 'g007', subject: 'Linear: Sprint 14 planning',      from: 'notifications@linear.app',  from_name: 'Linear',             labels: ['inbox', 'work'],     received_at: daysAgo(2),  thread_count: 3 },
  { id: 'g008', subject: 'Loom recording shared: "Demo walkthrough"', from: 'notify@loom.com', from_name: 'Loom',               labels: ['inbox', 'work'],     received_at: daysAgo(4),  thread_count: 1 },
  { id: 'g009', subject: '[Figma] Alex Rowe commented on Design tokens', from: 'noreply@figma.com', from_name: 'Figma',         labels: ['work'],              received_at: daysAgo(6),  thread_count: 4 },
  { id: 'g010', subject: 'Invite to join the Vana workspace', from: 'hi@vana.com',              from_name: 'Vana',               labels: ['inbox', 'work'],     received_at: daysAgo(9),  thread_count: 1 },

  // ── Auth / security ────────────────────────────────────────────────────────
  { id: 'g011', subject: 'New sign-in from Chrome on macOS', from: 'no-reply@accounts.google.com', from_name: 'Google',         labels: ['security'],          received_at: daysAgo(1),  thread_count: 1 },
  { id: 'g012', subject: 'Your verification code: 847 291', from: 'security@instagram.com',    from_name: 'Instagram',          labels: ['security'],          received_at: daysAgo(5),  thread_count: 1 },
  { id: 'g013', subject: 'Someone tried to sign in to your account', from: 'noreply@github.com', from_name: 'GitHub',          labels: ['security'],          received_at: daysAgo(14), thread_count: 1 },

  // ── Newsletters ───────────────────────────────────────────────────────────
  { id: 'g014', subject: 'The Pragmatic Engineer: AI and the software job market', from: 'pragmatic@substack.com', from_name: 'The Pragmatic Engineer', labels: ['newsletters'], received_at: daysAgo(2),  thread_count: 1 },
  { id: 'g015', subject: 'TLDR: OpenAI launches new reasoning model', from: 'dan@tldrnewsletter.com', from_name: 'TLDR Newsletter',  labels: ['newsletters'], received_at: daysAgo(3),  thread_count: 1 },
  { id: 'g016', subject: "Lenny's Newsletter: How Stripe builds product", from: 'lenny@substack.com', from_name: "Lenny's Newsletter", labels: ['newsletters'], received_at: daysAgo(7),  thread_count: 1 },
  { id: 'g017', subject: 'Bytes.dev: What\'s new in React 19',        from: 'ui@bytes.dev',             from_name: 'Bytes.dev',         labels: ['newsletters'], received_at: daysAgo(10), thread_count: 1 },

  // ── Travel ────────────────────────────────────────────────────────────────
  { id: 'g018', subject: 'Your Airbnb booking confirmed — San Francisco', from: 'automated@airbnb.com', from_name: 'Airbnb',         labels: ['travel'],          received_at: daysAgo(15), thread_count: 3 },
  { id: 'g019', subject: 'Booking confirmation: SF → NYC, May 3',     from: 'noreply@united.com',       from_name: 'United Airlines',   labels: ['travel'],          received_at: daysAgo(18), thread_count: 2 },

  // ── Personal ──────────────────────────────────────────────────────────────
  { id: 'g020', subject: 'Re: dinner Saturday?',                        from: 'alex.chen@gmail.com',      from_name: 'Alex Chen',         labels: ['inbox'],           received_at: daysAgo(1),  thread_count: 6 },
  { id: 'g021', subject: 'Photo album: ski trip 🎿',                    from: 'photos@google.com',        from_name: 'Google Photos',     labels: ['inbox'],           received_at: daysAgo(4),  thread_count: 1 },
  { id: 'g022', subject: 'Re: apartment lease renewal',                  from: 'landlord@realty.com',      from_name: 'Pacific Realty',    labels: ['inbox'],           received_at: daysAgo(20), thread_count: 4 },
];

/** Summary of what the connector collected — displayed in demo */
export const GMAIL_SUMMARY = {
  total_threads: SEED_GMAIL_THREADS.length,
  label_counts: {
    inbox:       SEED_GMAIL_THREADS.filter(t => t.labels.includes('inbox')).length,
    commerce:    SEED_GMAIL_THREADS.filter(t => t.labels.includes('commerce')).length,
    work:        SEED_GMAIL_THREADS.filter(t => t.labels.includes('work')).length,
    newsletters: SEED_GMAIL_THREADS.filter(t => t.labels.includes('newsletters')).length,
    travel:      SEED_GMAIL_THREADS.filter(t => t.labels.includes('travel')).length,
    security:    SEED_GMAIL_THREADS.filter(t => t.labels.includes('security')).length,
  },
};
