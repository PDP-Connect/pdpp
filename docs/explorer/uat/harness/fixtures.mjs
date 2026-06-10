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
    id: "acct_demo_checking|FIT-2026-04-22-0001",
    account_id: "acct_demo_checking",
    account_name: "Demo Checking",
    fitid: "FIT-2026-04-22-0001",
    date: "2026-04-22",
    amount: -1245, // -$12.45
    currency: "USD",
    type: "DEBIT",
    name: "Bluebird Bakery",
    memo: "PURCHASE - PORTLAND OR",
    source: "qfx",
    fetched_at: "2026-04-23T08:00:00Z",
  },
  {
    id: "acct_demo_checking|FIT-2026-04-20-0002",
    account_id: "acct_demo_checking",
    account_name: "Demo Checking",
    fitid: "FIT-2026-04-20-0002",
    date: "2026-04-20",
    amount: 438_120, // +$4,381.20 (payroll credit)
    currency: "USD",
    type: "CREDIT",
    name: "Acme Payroll Direct Deposit",
    memo: "ACME CORP DIR DEP",
    source: "qfx",
    fetched_at: "2026-04-21T08:00:00Z",
  },
  {
    id: "acct_demo_checking|FIT-2026-04-18-0003",
    account_id: "acct_demo_checking",
    account_name: "Demo Checking",
    fitid: "FIT-2026-04-18-0003",
    date: "2026-04-18",
    amount: -8900, // -$89.00
    currency: "USD",
    type: "DEBIT",
    name: "Northwind Utilities",
    memo: "AUTOPAY ELECTRIC",
    source: "qfx",
    fetched_at: "2026-04-19T08:00:00Z",
  },
  {
    id: "acct_demo_checking|FIT-2026-04-15-0004",
    account_id: "acct_demo_checking",
    account_name: "Demo Checking",
    fitid: "FIT-2026-04-15-0004",
    date: "2026-04-15",
    amount: -2840, // -$28.40
    currency: "USD",
    type: "DEBIT",
    name: "Fabrikam Coffee Roasters",
    memo: "CARD PURCHASE",
    source: "qfx",
    fetched_at: "2026-04-16T08:00:00Z",
  },
  {
    id: "acct_demo_checking|FIT-2026-04-12-0005",
    account_id: "acct_demo_checking",
    account_name: "Demo Checking",
    fitid: "FIT-2026-04-12-0005",
    date: "2026-04-12",
    amount: -15_600, // -$156.00
    currency: "USD",
    type: "DEBIT",
    name: "Contoso Groceries",
    memo: "POS PURCHASE",
    source: "qfx",
    fetched_at: "2026-04-13T08:00:00Z",
  },
];

// gmail `messages` — drives the MESSAGE card via declared `from_name: person`
// + `snippet/subject: text`.
export const GMAIL_MESSAGES = [
  {
    id: "msg_demo_0001",
    thread_id: "thread_demo_a",
    subject: "Your April statement is ready",
    from_name: "Demo Bank Alerts",
    from_email: "alerts@demo-bank.example",
    to: ["owner@example.test"],
    date: "2026-04-22T14:05:00Z",
    received_at: "2026-04-22T14:05:02Z",
    snippet: "Your latest account statement is now available to view online. No action is required.",
  },
  {
    id: "msg_demo_0002",
    thread_id: "thread_demo_b",
    subject: "Re: Lunch on Thursday?",
    from_name: "Jordan Rivera",
    from_email: "jordan@example.test",
    to: ["owner@example.test"],
    date: "2026-04-21T17:42:00Z",
    received_at: "2026-04-21T17:42:03Z",
    snippet: "Thursday works great for me. Want to try that new ramen place near the office?",
  },
  {
    id: "msg_demo_0003",
    thread_id: "thread_demo_c",
    subject: "Order shipped: #DM-48213",
    from_name: "Fabrikam Shop",
    from_email: "orders@fabrikam.example",
    to: ["owner@example.test"],
    date: "2026-04-20T09:13:00Z",
    received_at: "2026-04-20T09:13:01Z",
    snippet: "Good news — your order is on the way and should arrive within 3 business days.",
  },
  {
    id: "msg_demo_0004",
    thread_id: "thread_demo_d",
    subject: "Project sync notes",
    from_name: "Priya Anand",
    from_email: "priya@example.test",
    to: ["owner@example.test"],
    date: "2026-04-19T11:00:00Z",
    received_at: "2026-04-19T11:00:04Z",
    snippet: "Sharing the notes from this morning's sync. Highlights and action items are at the top.",
  },
  {
    id: "msg_demo_0005",
    thread_id: "thread_demo_e",
    subject: "Welcome to Contoso Cloud",
    from_name: "Contoso Team",
    from_email: "welcome@contoso.example",
    to: ["owner@example.test"],
    date: "2026-04-18T08:30:00Z",
    received_at: "2026-04-18T08:30:02Z",
    snippet: "Thanks for signing up. Here are a few tips to help you get started with your new workspace.",
  },
];
