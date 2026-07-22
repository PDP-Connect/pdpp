// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Synthetic, real-SHAPED fixture records for the Explorer live-fidelity UAT.
 *
 * These match the committed `chase.json` (transactions) and `gmail.json`
 * (messages) manifest schemas field-for-field, including the fields that carry
 * `x_pdpp_type` declarations (chase: amount=currency, date=timestamp,
 * name=text; gmail: from_name=person, subject/snippet=text, date=timestamp).
 *
 * NO real PII. Every merchant, name, email, and subject is invented. Amounts and
 * dates are plausible but fabricated. This is fixture data, not a captured run.
 */

export const CHASE_CONNECTOR_ID = "https://registry.pdpp.org/connectors/chase";
export const GMAIL_CONNECTOR_ID = "https://registry.pdpp.org/connectors/gmail";

// chase `transactions` — drives the MONEY card via declared `amount: currency`.
export const CHASE_TRANSACTIONS = [
  {
    account_id: "acct_demo_checking",
    account_name: "Demo Checking",
    amount: -1245, // -$12.45
    currency: "USD",
    date: "2026-04-22",
    fetched_at: "2026-04-23T08:00:00Z",
    fitid: "FIT-2026-04-22-0001",
    id: "acct_demo_checking|FIT-2026-04-22-0001",
    memo: "PURCHASE - PORTLAND OR",
    name: "Bluebird Bakery",
    source: "qfx",
    type: "DEBIT",
  },
  {
    account_id: "acct_demo_checking",
    account_name: "Demo Checking",
    amount: 438_120, // +$4,381.20 (payroll credit)
    currency: "USD",
    date: "2026-04-20",
    fetched_at: "2026-04-21T08:00:00Z",
    fitid: "FIT-2026-04-20-0002",
    id: "acct_demo_checking|FIT-2026-04-20-0002",
    memo: "ACME CORP DIR DEP",
    name: "Acme Payroll Direct Deposit",
    source: "qfx",
    type: "CREDIT",
  },
  {
    account_id: "acct_demo_checking",
    account_name: "Demo Checking",
    amount: -8900, // -$89.00
    currency: "USD",
    date: "2026-04-18",
    fetched_at: "2026-04-19T08:00:00Z",
    fitid: "FIT-2026-04-18-0003",
    id: "acct_demo_checking|FIT-2026-04-18-0003",
    memo: "AUTOPAY ELECTRIC",
    name: "Northwind Utilities",
    source: "qfx",
    type: "DEBIT",
  },
  {
    account_id: "acct_demo_checking",
    account_name: "Demo Checking",
    amount: -2840, // -$28.40
    currency: "USD",
    date: "2026-04-15",
    fetched_at: "2026-04-16T08:00:00Z",
    fitid: "FIT-2026-04-15-0004",
    id: "acct_demo_checking|FIT-2026-04-15-0004",
    memo: "CARD PURCHASE",
    name: "Fabrikam Coffee Roasters",
    source: "qfx",
    type: "DEBIT",
  },
  {
    account_id: "acct_demo_checking",
    account_name: "Demo Checking",
    amount: -15_600, // -$156.00
    currency: "USD",
    date: "2026-04-12",
    fetched_at: "2026-04-13T08:00:00Z",
    fitid: "FIT-2026-04-12-0005",
    id: "acct_demo_checking|FIT-2026-04-12-0005",
    memo: "POS PURCHASE",
    name: "Contoso Groceries",
    source: "qfx",
    type: "DEBIT",
  },
];

// gmail `messages` — drives the MESSAGE card via declared `from_name: person`
// + `snippet/subject: text`.
export const GMAIL_MESSAGES = [
  {
    date: "2026-04-22T14:05:00Z",
    from_email: "alerts@demo-bank.example",
    from_name: "Demo Bank Alerts",
    id: "msg_demo_0001",
    received_at: "2026-04-22T14:05:02Z",
    snippet: "Your latest account statement is now available to view online. No action is required.",
    subject: "Your April statement is ready",
    thread_id: "thread_demo_a",
    to: ["owner@example.test"],
  },
  {
    date: "2026-04-21T17:42:00Z",
    from_email: "jordan@example.test",
    from_name: "Jordan Rivera",
    id: "msg_demo_0002",
    received_at: "2026-04-21T17:42:03Z",
    snippet: "Thursday works great for me. Want to try that new ramen place near the office?",
    subject: "Re: Lunch on Thursday?",
    thread_id: "thread_demo_b",
    to: ["owner@example.test"],
  },
  {
    date: "2026-04-20T09:13:00Z",
    from_email: "orders@fabrikam.example",
    from_name: "Fabrikam Shop",
    id: "msg_demo_0003",
    received_at: "2026-04-20T09:13:01Z",
    snippet: "Good news — your order is on the way and should arrive within 3 business days.",
    subject: "Order shipped: #DM-48213",
    thread_id: "thread_demo_c",
    to: ["owner@example.test"],
  },
  {
    date: "2026-04-19T11:00:00Z",
    from_email: "priya@example.test",
    from_name: "Priya Anand",
    id: "msg_demo_0004",
    received_at: "2026-04-19T11:00:04Z",
    snippet: "Sharing the notes from this morning's sync. Highlights and action items are at the top.",
    subject: "Project sync notes",
    thread_id: "thread_demo_d",
    to: ["owner@example.test"],
  },
  {
    date: "2026-04-18T08:30:00Z",
    from_email: "welcome@contoso.example",
    from_name: "Contoso Team",
    id: "msg_demo_0005",
    received_at: "2026-04-18T08:30:02Z",
    snippet: "Thanks for signing up. Here are a few tips to help you get started with your new workspace.",
    subject: "Welcome to Contoso Cloud",
    thread_id: "thread_demo_e",
    to: ["owner@example.test"],
  },
];
