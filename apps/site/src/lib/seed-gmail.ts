// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Seed data for the Gmail connector reference fixture.
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
  {
    from: "no-reply@amazon.com",
    from_name: "Amazon",
    id: "g001",
    labels: ["inbox", "commerce"],
    received_at: daysAgo(1),
    subject: "Your order has shipped — #13849",
    thread_count: 2,
  },
  {
    from: "receipts@stripe.com",
    from_name: "Stripe",
    id: "g002",
    labels: ["inbox", "commerce"],
    received_at: daysAgo(3),
    subject: "Your receipt from Stripe",
    thread_count: 1,
  },
  {
    from: "billing@figma.com",
    from_name: "Figma",
    id: "g003",
    labels: ["commerce"],
    received_at: daysAgo(8),
    subject: "Your Figma invoice #INV-2841",
    thread_count: 1,
  },
  {
    from: "billing@vercel.com",
    from_name: "Vercel",
    id: "g004",
    labels: ["commerce"],
    received_at: daysAgo(12),
    subject: "New order confirmation — Vercel",
    thread_count: 1,
  },
  {
    from: "billing@github.com",
    from_name: "GitHub",
    id: "g005",
    labels: ["commerce"],
    received_at: daysAgo(22),
    subject: "Your GitHub subscription",
    thread_count: 2,
  },

  // ── Work / collaboration ───────────────────────────────────────────────────
  {
    from: "noreply@github.com",
    from_name: "GitHub",
    id: "g006",
    labels: ["inbox", "work"],
    received_at: daysAgo(0),
    subject: "PR review: feat/pdpp-consent-flow",
    thread_count: 5,
  },
  {
    from: "notifications@linear.app",
    from_name: "Linear",
    id: "g007",
    labels: ["inbox", "work"],
    received_at: daysAgo(2),
    subject: "Linear: Sprint 14 planning",
    thread_count: 3,
  },
  {
    from: "notify@loom.com",
    from_name: "Loom",
    id: "g008",
    labels: ["inbox", "work"],
    received_at: daysAgo(4),
    subject: 'Loom recording shared: "Demo walkthrough"',
    thread_count: 1,
  },
  {
    from: "noreply@figma.com",
    from_name: "Figma",
    id: "g009",
    labels: ["work"],
    received_at: daysAgo(6),
    subject: "[Figma] Alex Rowe commented on Design tokens",
    thread_count: 4,
  },
  {
    from: "hi@acme.example",
    from_name: "Acme",
    id: "g010",
    labels: ["inbox", "work"],
    received_at: daysAgo(9),
    subject: "Invite to join the Acme workspace",
    thread_count: 1,
  },

  // ── Auth / security ────────────────────────────────────────────────────────
  {
    from: "no-reply@accounts.google.com",
    from_name: "Google",
    id: "g011",
    labels: ["security"],
    received_at: daysAgo(1),
    subject: "New sign-in from Chrome on macOS",
    thread_count: 1,
  },
  {
    from: "security@instagram.com",
    from_name: "Instagram",
    id: "g012",
    labels: ["security"],
    received_at: daysAgo(5),
    subject: "Your verification code: 847 291",
    thread_count: 1,
  },
  {
    from: "noreply@github.com",
    from_name: "GitHub",
    id: "g013",
    labels: ["security"],
    received_at: daysAgo(14),
    subject: "Someone tried to sign in to your account",
    thread_count: 1,
  },

  // ── Newsletters ───────────────────────────────────────────────────────────
  {
    from: "pragmatic@substack.com",
    from_name: "The Pragmatic Engineer",
    id: "g014",
    labels: ["newsletters"],
    received_at: daysAgo(2),
    subject: "The Pragmatic Engineer: AI and the software job market",
    thread_count: 1,
  },
  {
    from: "dan@tldrnewsletter.com",
    from_name: "TLDR Newsletter",
    id: "g015",
    labels: ["newsletters"],
    received_at: daysAgo(3),
    subject: "TLDR: OpenAI launches new reasoning model",
    thread_count: 1,
  },
  {
    from: "lenny@substack.com",
    from_name: "Lenny's Newsletter",
    id: "g016",
    labels: ["newsletters"],
    received_at: daysAgo(7),
    subject: "Lenny's Newsletter: How Stripe builds product",
    thread_count: 1,
  },
  {
    from: "ui@bytes.dev",
    from_name: "Bytes.dev",
    id: "g017",
    labels: ["newsletters"],
    received_at: daysAgo(10),
    subject: "Bytes.dev: What's new in React 19",
    thread_count: 1,
  },

  // ── Travel ────────────────────────────────────────────────────────────────
  {
    from: "automated@airbnb.com",
    from_name: "Airbnb",
    id: "g018",
    labels: ["travel"],
    received_at: daysAgo(15),
    subject: "Your Airbnb booking confirmed — San Francisco",
    thread_count: 3,
  },
  {
    from: "noreply@united.com",
    from_name: "United Airlines",
    id: "g019",
    labels: ["travel"],
    received_at: daysAgo(18),
    subject: "Booking confirmation: SF → NYC, May 3",
    thread_count: 2,
  },

  // ── Personal ──────────────────────────────────────────────────────────────
  {
    from: "alex.chen@gmail.com",
    from_name: "Alex Chen",
    id: "g020",
    labels: ["inbox"],
    received_at: daysAgo(1),
    subject: "Re: dinner Saturday?",
    thread_count: 6,
  },
  {
    from: "photos@google.com",
    from_name: "Google Photos",
    id: "g021",
    labels: ["inbox"],
    received_at: daysAgo(4),
    subject: "Photo album: ski trip 🎿",
    thread_count: 1,
  },
  {
    from: "landlord@realty.com",
    from_name: "Pacific Realty",
    id: "g022",
    labels: ["inbox"],
    received_at: daysAgo(20),
    subject: "Re: apartment lease renewal",
    thread_count: 4,
  },
];

/** Summary of what the connector collected — displayed in the reference fixture */
export const GMAIL_SUMMARY = {
  label_counts: {
    commerce: SEED_GMAIL_THREADS.filter((t) => t.labels.includes("commerce")).length,
    inbox: SEED_GMAIL_THREADS.filter((t) => t.labels.includes("inbox")).length,
    newsletters: SEED_GMAIL_THREADS.filter((t) => t.labels.includes("newsletters")).length,
    security: SEED_GMAIL_THREADS.filter((t) => t.labels.includes("security")).length,
    travel: SEED_GMAIL_THREADS.filter((t) => t.labels.includes("travel")).length,
    work: SEED_GMAIL_THREADS.filter((t) => t.labels.includes("work")).length,
  },
  total_threads: SEED_GMAIL_THREADS.length,
};
