/**
 * Seeded RecordsExplorerData for the /design-system/explore showcase.
 *
 * This is a SCREENSHOT-ONLY fixture (fictional persona data) that exercises the
 * real `RecordsExplorerData` contract the live page assembles: connection
 * facets, day-grouped feed entries with structured previews, an active peek with
 * a WITHHELD field (grant-lens "Stays with you" rail), a SERVER-DECLARED blob
 * affordance on a Gmail attachment (so the feed badge + inspector blob render
 * from the declared signal, not a URL regex), and a DECLARED relationship
 * (`EXPLORE_SHOWCASE_RELATIONSHIPS`, mirroring what the server-side
 * `buildPeekRelationships` resolves from `expand_capabilities`). Nothing here
 * touches the network — the live page never imports this module.
 */
import type { RecordsExplorerData } from "@pdpp/operator-ui/components/views/records-explorer-view";
import type { PeekRelationships } from "../../dashboard/explore/explore-peek-relationships.ts";

const TODAY = "2026-06-13";
const YESTERDAY = "2026-06-12";
const TWO_AGO = "2026-06-11";

const CONNECTION_ID = "conn_bank_chk";

export const EXPLORE_SHOWCASE_DATA: RecordsExplorerData = {
  query: "",
  connections: [
    {
      connectionId: "conn_mail_work",
      connectorId: "gmail",
      displayName: "Gmail (work)",
      streams: ["messages", "attachments"],
    },
    {
      connectionId: "conn_bank_chk",
      connectorId: "chase",
      displayName: "Chase · checking",
      streams: ["transactions", "accounts"],
    },
    {
      connectionId: "conn_agent_laptop",
      connectorId: "claude_code",
      displayName: "Claude Code (laptop)",
      streams: ["messages", "sessions"],
    },
  ],
  selectedConnectionIds: [],
  selectedStreams: [],
  // Declared exact-filterable fields across the in-scope streams. A
  // `merchant:coffee` query renders as a real `filter[merchant]=coffee` server
  // param; an undeclared field stays client-side. (Screenshot value.)
  serverFilterableFields: ["merchant", "category", "account_id"],
  since: "",
  until: "",
  lens: "recent",
  fromSearch: false,
  hybridUsed: false,
  truncated: false,
  activitySummary: { source: "bounded_sample", text: "48,120 on your server" },
  warnings: [],
  feed: [
    // ── Today ──
    {
      connectorId: "chase",
      connectionId: "conn_bank_chk",
      connectionDisplayName: "Chase · checking",
      stream: "transactions",
      recordId: "rec_tx_41203",
      emittedAt: `${TODAY}T16:11:00Z`,
      displayAt: `${TODAY}T16:11:00Z`,
      kind: "money",
      summary: "Blue Bottle Coffee · -$6.40",
      preview: { kind: "money", title: "Blue Bottle Coffee", amount: "-$6.40", body: "coffee & cafes" },
    },
    {
      connectorId: "chase",
      connectionId: "conn_bank_chk",
      connectionDisplayName: "Chase · checking",
      stream: "transactions",
      recordId: "rec_tx_41195",
      emittedAt: `${TODAY}T09:02:00Z`,
      displayAt: `${TODAY}T09:02:00Z`,
      kind: "money",
      summary: "Hawthorne Property Mgmt · -$1,850.00",
      preview: { kind: "money", title: "Hawthorne Property Mgmt", amount: "-$1,850.00", body: "rent · june" },
    },
    {
      connectorId: "gmail",
      connectionId: "conn_mail_work",
      connectionDisplayName: "Gmail (work)",
      stream: "messages",
      recordId: "rec_msg_8841",
      emittedAt: `${TODAY}T08:30:00Z`,
      displayAt: `${TODAY}T08:30:00Z`,
      kind: "message",
      summary: "Re: consent ceremony copy review",
      preview: {
        kind: "message",
        title: "Re: consent ceremony copy review",
        author: "dana@studio.example",
        body: "Ship the warmer variant — owner reads it first.",
      },
    },
    // ── Yesterday ──
    {
      connectorId: "claude_code",
      connectionId: "conn_agent_laptop",
      connectionDisplayName: "Claude Code (laptop)",
      stream: "sessions",
      recordId: "rec_sess_0388",
      emittedAt: `${YESTERDAY}T16:11:00Z`,
      displayAt: `${YESTERDAY}T16:11:00Z`,
      kind: "titled",
      summary: "Sketch the consent ceremony copy variants",
      preview: { kind: "titled", title: "Sketch the consent ceremony copy variants", author: "assistant" },
    },
    {
      connectorId: "chase",
      connectionId: "conn_bank_chk",
      connectionDisplayName: "Chase · checking",
      stream: "accounts",
      recordId: "acct_checking_4417",
      emittedAt: `${YESTERDAY}T06:00:00Z`,
      displayAt: `${YESTERDAY}T06:00:00Z`,
      kind: "titled",
      summary: "checking ····4417",
      preview: { kind: "titled", title: "checking ····4417", body: "primary checking" },
    },
    {
      connectorId: "gmail",
      connectionId: "conn_mail_work",
      connectionDisplayName: "Gmail (work)",
      stream: "attachments",
      recordId: "rec_att_2207",
      emittedAt: `${YESTERDAY}T05:40:00Z`,
      displayAt: `${YESTERDAY}T05:40:00Z`,
      kind: "generic",
      summary: "wireframe-v3.png · 184 KB",
      preview: { kind: "generic", title: "wireframe-v3.png", body: "image/png · 184 KB" },
      // SERVER-DECLARED blob (field_capabilities.type === "blob" → buildBlobAffordance).
      // Drives the feed "image" badge from the declared signal, never a URL regex.
      blobAffordance: {
        fieldName: "blob_ref",
        href: "https://placehold.co/600x240.png",
        state: "available",
      },
    },
    // ── Two days ago ──
    {
      connectorId: "claude_code",
      connectionId: "conn_agent_laptop",
      connectionDisplayName: "Claude Code (laptop)",
      stream: "messages",
      recordId: "rec_cc_msg_5510",
      emittedAt: `${TWO_AGO}T14:22:00Z`,
      displayAt: `${TWO_AGO}T14:22:00Z`,
      kind: "message",
      summary: "Here is the summary you asked for…",
      preview: {
        kind: "message",
        author: "assistant",
        body: "Here is the summary you asked for. The reading region kicks in once a body crosses the length threshold.",
      },
    },
  ],
  // Active inspector: the coffee transaction. It exercises ALL server-backed
  // paths in ONE screenshot:
  //   - a DECLARED blob (`receipt`, type "blob") → inspector renders the inline
  //     image + "Open blob →" from the declared `blobAffordance`, not a URL regex;
  //   - a DECLARED relationship → the "Connected" rail (see
  //     EXPLORE_SHOWCASE_RELATIONSHIPS), the same shape buildPeekRelationships
  //     resolves from `expand_capabilities`;
  //   - a WITHHELD `memo` → the grant-lens "Stays with you" rail.
  peek: {
    connectorId: "chase",
    connectionId: CONNECTION_ID,
    connectionDisplayName: "Chase · checking",
    stream: "transactions",
    recordId: "rec_tx_41203",
    emittedAt: `${TODAY}T16:11:00Z`,
    readUrl: "/v1/records/chase/transactions/rec_tx_41203",
    error: null,
    bodyJson: JSON.stringify(
      {
        date: "2026-06-13",
        amount: -640,
        merchant: "Blue Bottle Coffee",
        category: "coffee & cafes",
        account_id: "acct_checking_4417",
        receipt: {
          blob_id: "blob_receipt_41203",
          mime_type: "image/png",
          fetch_url: "https://placehold.co/600x240.png",
        },
        memo: "card present",
      },
      null,
      2
    ),
    fields: [
      { name: "date", state: "visible", type: "temporal", valueJson: '"2026-06-13"' },
      { name: "amount", state: "visible", type: "currency", valueJson: "-640" },
      { name: "merchant", state: "visible", type: "text", valueJson: '"Blue Bottle Coffee"' },
      { name: "category", state: "visible", type: "text", valueJson: '"coffee & cafes"' },
      { name: "account_id", state: "visible", type: "text", valueJson: '"acct_checking_4417"' },
      // Declared blob field → drives the inspector inline image + "Open blob →".
      {
        name: "receipt",
        state: "visible",
        type: "blob",
        valueJson: '{"blob_id":"blob_receipt_41203","mime_type":"image/png"}',
        blobAffordance: {
          fieldName: "receipt",
          href: "https://placehold.co/600x240.png",
          state: "available",
        },
      },
      // Withheld under an active projection → drives the "Stays with you" rail.
      { name: "memo", state: "withheld", type: "text", valueJson: null },
    ],
  },
};

/**
 * Seeded relationship links for the showcase inspector, mirroring what the live
 * page's `buildPeekRelationships` resolves from declared `expand_capabilities` +
 * connector manifests. The coffee transaction declares a `has_one` back to its
 * parent `accounts` record via `account_id` → one navigable child → parent link.
 */
export const EXPLORE_SHOWCASE_RELATIONSHIPS: PeekRelationships = {
  relatedLinks: [],
  reverseChildListLinks: [],
  parentBackLinks: [
    {
      childParentKeyField: "account_id",
      parentStream: "accounts",
      href: `/dashboard/records/${CONNECTION_ID}/accounts/acct_checking_4417`,
    },
  ],
};
