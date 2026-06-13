/**
 * PDPP Explorer — seed data
 *
 * Mirrors what a real `/v1/schema` + `/v1/streams` response would look like
 * for a grant authorized across the bundled polyfill connectors. The
 * Explorer is dispatch-driven (see dispatch.js); none of this data is
 * special-cased by connector id anywhere downstream.
 *
 * Date anchor: May 24, 2026 (today).
 */

// ─── helpers ────────────────────────────────────────────────────────────
const NOW = new Date("2026-05-24T16:30:00-07:00").getTime();
const DAY = 86400_000;
const HOUR = 3600_000;
const MIN = 60_000;
const ago = (ms) => new Date(NOW - ms).toISOString();
const at = (d) => new Date(d).toISOString();
let _rid = 0; const rid = (prefix) => `${prefix}_${(++_rid).toString(36).padStart(5, "0")}`;

// ─── grant ──────────────────────────────────────────────────────────────
const grant = {
  grant_id: "g_lv_2026_05_17_b91a",
  client_id: "longview.app",
  client_display: "Longview",
  client_summary: "Compensation planning workspace",
  status: "active",
  issued_at: ago(7 * DAY),
  expires_at: at(NOW + 14 * DAY),
  scope: "single_use_extended",
  access_mode: "continuous",
  granted_streams: [
    "gmail/messages", "slack/messages", "chase/transactions",
    "amazon/orders", "github/events", "strava/activities",
    "photos/media", "oura/sleep", "calendar/events",
  ],
  granted_field_count: 47,
  total_field_count: 112,
};

// ─── connections ────────────────────────────────────────────────────────
const connections = [
  { id: "c_gmail_p",   connector_id: "gmail",          display_name: "the owner@nunamak.com",      group: "Google",   account_kind: "personal" },
  { id: "c_gmail_w",   connector_id: "gmail",          display_name: "the owner@vana.org",         group: "Google",   account_kind: "work" },
  { id: "c_photos",    connector_id: "google_takeout", display_name: "the owner@nunamak.com",      group: "Google",   account_kind: "personal" },
  { id: "c_slack",     connector_id: "slack",          display_name: "vana.slack.com",       group: "Slack",    account_kind: "work" },
  { id: "c_chase",     connector_id: "chase",          display_name: "Chase •6432",          group: "Chase",    account_kind: "personal" },
  { id: "c_amazon",    connector_id: "amazon",         display_name: "the owner@nunamak.com",      group: "Amazon",   account_kind: "personal" },
  { id: "c_github",    connector_id: "github",         display_name: "owner",             group: "GitHub",   account_kind: "personal" },
  { id: "c_strava",    connector_id: "strava",         display_name: "the owner Nunamaker",        group: "Strava",   account_kind: "personal" },
  { id: "c_oura",      connector_id: "oura",           display_name: "Ring Gen3 · silver",   group: "Oura",     account_kind: "personal" },
  { id: "c_ical",      connector_id: "ical",           display_name: "personal.ics",         group: "Calendar", account_kind: "personal" },
];

// ─── streams: schema + records ──────────────────────────────────────────
// Schemas declare typed fields; dispatch.js infers capabilities from these.
// Records are flat JSON; views render them generically.

// GMAIL ─────────────────────────────────────────────────────────────────
const gmailFields = [
  { name: "id",         type: "id",        granted: true },
  { name: "thread_id",  type: "id",        granted: true },
  { name: "from",       type: "person",    granted: true },
  { name: "to",         type: "person[]",  granted: true },
  { name: "subject",    type: "text",      granted: true },
  { name: "snippet",    type: "text",      granted: true },
  { name: "body",       type: "text",      granted: false, redacted_reason: "client requested only headers + snippet" },
  { name: "date",       type: "timestamp", granted: true },
  { name: "labels",     type: "enum[]",    granted: true },
  { name: "has_attachment", type: "boolean", granted: true },
];
const gmailViews = ["all", "unread", "this_week", "starred"];

const gmailPersonalRecords = [
  { id: rid("gm"), thread_id: "t01", from: "Maya Chen <maya.chen@figma.com>", to: ["the owner@nunamak.com"], subject: "re: portfolio review thursday", snippet: "Thursday 2pm still works on my end. I'll bring the redlines from the consent flow we talked about — curious what you think of the copper rule on…", date: ago(2 * HOUR), labels: ["Inbox", "Starred"], has_attachment: false, body: "Thursday 2pm still works on my end. I'll bring the redlines from the consent flow we talked about — curious what you think of the copper rule on the grant inspector. Also: I think I figured out the weird thing with the right-pane scrim, I'll show you in person.\n\nMaya" },
  { id: rid("gm"), thread_id: "t02", from: "Southwest Airlines <noreply@iluv.southwest.com>", to: ["the owner@nunamak.com"], subject: "Your trip to Austin is confirmed — May 31", snippet: "Confirmation L4M2QP · the owner Nunamaker · SFO → AUS · Sat May 31 · 6:35a · Wanna Get Away+", date: ago(8 * HOUR), labels: ["Inbox", "Travel"], has_attachment: true },
  { id: rid("gm"), thread_id: "t03", from: "Anthropic <noreply@account.anthropic.com>", to: ["the owner@nunamak.com"], subject: "Your monthly receipt", snippet: "Receipt for May 2026 — Claude Pro $20.00 charged to Visa ending in 6432. Thanks for being a subscriber.", date: ago(1 * DAY + 4 * HOUR), labels: ["Inbox", "Receipts"], has_attachment: true },
  { id: rid("gm"), thread_id: "t04", from: "mom <ellen.nunamaker@gmail.com>", to: ["the owner@nunamak.com"], subject: "the chickens", snippet: "Hattie laid a green egg today!! It's the size of a quarter. Sending pics. Dad says hi and is mad about the gutters again.", date: ago(2 * DAY), labels: ["Inbox"], has_attachment: true },
  { id: rid("gm"), thread_id: "t05", from: "Tara Patel <tara@longview.app>", to: ["the owner@nunamak.com"], subject: "Longview client integration — grant ready?", snippet: "Hi the owner — we got our scoped grant approved this morning. Wanted to flag: we're noticing some streams come back with `connection_id` populated and some without…", date: ago(3 * DAY + 6 * HOUR), labels: ["Inbox"], has_attachment: false },
  { id: rid("gm"), thread_id: "t06", from: "Strava <no-reply@strava.com>", to: ["the owner@nunamak.com"], subject: "Your weekly summary: 31.4 mi", snippet: "Nice work this week. 3 runs · 31.4 mi · 4h 48m · 1,247 ft elevation. New all-time best for May.", date: ago(4 * DAY), labels: ["Inbox", "Updates"], has_attachment: false },
  { id: rid("gm"), thread_id: "t07", from: "Chase Online <no-reply@chase.com>", to: ["the owner@nunamak.com"], subject: "Alert: large purchase on •6432", snippet: "A $487.14 purchase at Apple Store was made on May 19. If this was you, no action needed. Otherwise reply STOP or call us.", date: ago(5 * DAY), labels: ["Inbox", "Banking"], has_attachment: false },
  { id: rid("gm"), thread_id: "t08", from: "GitHub <noreply@github.com>", to: ["the owner@nunamak.com"], subject: "[vana-com/pdpp] PR #847 was merged: capability dispatch in explorer", snippet: "Merged by @maya-chen · 12 files changed · +482 −137", date: ago(6 * DAY), labels: ["Inbox", "Code"], has_attachment: false },
  { id: rid("gm"), thread_id: "t09", from: "Spotify <no-reply@spotify.com>", to: ["the owner@nunamak.com"], subject: "Your minutes this month: 1,847", snippet: "You listened more than 87% of users in San Francisco this month. Top artist: Caroline Polachek. Top genre: art pop.", date: ago(8 * DAY), labels: ["Inbox"], has_attachment: false },
  { id: rid("gm"), thread_id: "t10", from: "Maya Chen <maya.chen@figma.com>", to: ["the owner@nunamak.com"], subject: "stair brewery sat?", snippet: "they have the saison on tap again. 4ish? bring the dog", date: ago(12 * DAY), labels: ["Inbox", "Starred"], has_attachment: false },
  { id: rid("gm"), thread_id: "t11", from: "Costco Wholesale <orders@costco.com>", to: ["the owner@nunamak.com"], subject: "Your Costco order is ready for pickup", snippet: "Order #C-58291 · Pickup window: May 14, 4–6pm · 8 items · Total: $213.47", date: ago(14 * DAY), labels: ["Inbox", "Receipts"], has_attachment: false },
  { id: rid("gm"), thread_id: "t12", from: "ACLU <action@aclu.org>", to: ["the owner@nunamak.com"], subject: "the owner — your May donation receipt", snippet: "Thank you for your monthly $25 contribution. Tax receipt attached. Every dollar funds the fight.", date: ago(18 * DAY), labels: ["Inbox", "Receipts"], has_attachment: true },
];

const gmailWorkRecords = [
  { id: rid("gm"), thread_id: "t20", from: "a person Vasquez <a person@vana.org>", to: ["the owner@vana.org"], subject: "[PDPP] design review — explorer prototype", snippet: "Sending notes from yesterday. tldr: the field-projection toggle is the killer feature, lean into it. also: command-K should default to lexical not semantic.", date: ago(4 * HOUR), labels: ["Inbox", "Important"], has_attachment: false },
  { id: rid("gm"), thread_id: "t21", from: "a person Vasquez <a person@vana.org>", to: ["the owner@vana.org", "maya@vana.org"], subject: "Re: launch readiness sync", snippet: "Pushing tomorrow's standup to 10:30 — Maya has the IETF call at 9. Agenda is in the doc, anyone can add.", date: ago(1 * DAY), labels: ["Inbox"], has_attachment: false },
  { id: rid("gm"), thread_id: "t22", from: "Calendar <calendar-notification@google.com>", to: ["the owner@vana.org"], subject: "Invitation: PDPP biweekly (May 27)", snippet: "Wed May 27 · 11:00–11:30 · a person, Maya, the owner, Drew · Zoom · recurring biweekly", date: ago(2 * DAY), labels: ["Inbox", "Calendar"], has_attachment: false },
  { id: rid("gm"), thread_id: "t23", from: "Drew Park <drew@vana.org>", to: ["the owner@vana.org"], subject: "fwd: from the IETF list", snippet: "Worth a read — the working group is converging on something close to PDPP's grant model. They're calling it scoped-read profiles.", date: ago(5 * DAY), labels: ["Inbox"], has_attachment: false },
  { id: rid("gm"), thread_id: "t24", from: "1Password <noreply@1password.com>", to: ["the owner@vana.org"], subject: "New device signed in", snippet: "A new device (MacBook Pro · Safari 18) signed into your work vault from San Francisco, CA. If this was you, no action needed.", date: ago(8 * DAY), labels: ["Inbox", "Security"], has_attachment: false },
  { id: rid("gm"), thread_id: "t25", from: "Notion <team@mail.notion.so>", to: ["the owner@vana.org"], subject: "a person shared a page with you: \"explorer copy passes\"", snippet: "a person Vasquez shared the page \"explorer copy passes\" in the Vana workspace. 14 comments waiting.", date: ago(10 * DAY), labels: ["Inbox"], has_attachment: false },
];

// SLACK ─────────────────────────────────────────────────────────────────
const slackFields = [
  { name: "id",          type: "id",        granted: true },
  { name: "channel_id",  type: "id",        granted: true },
  { name: "channel",     type: "text",      granted: true },
  { name: "thread_ts",   type: "id",        granted: true },
  { name: "author",      type: "person",    granted: true },
  { name: "text",        type: "text",      granted: true },
  { name: "ts",          type: "timestamp", granted: true },
  { name: "reactions",   type: "json",      granted: true },
  { name: "is_dm",       type: "boolean",   granted: true },
];
const slackViews = ["all", "this_week", "channels", "dms", "threads_im_in"];

const slackRecords = [
  { id: rid("sl"), channel: "#eng-platform", channel_id: "C01", thread_ts: null, author: "a person Vasquez", text: "ok the dispatch is in. capability detection working for gmail/slack/chase. amazon/strava next.", ts: ago(45 * MIN), reactions: [{emoji: "🚀", count: 3}, {emoji: "👀", count: 1}], is_dm: false },
  { id: rid("sl"), channel: "#eng-platform", channel_id: "C01", thread_ts: null, author: "the owner Nunamaker", text: "nice. how is it handling streams with mixed signals (e.g. photos has timestamp + geo + blob)?", ts: ago(40 * MIN), reactions: [], is_dm: false },
  { id: rid("sl"), channel: "#eng-platform", channel_id: "C01", thread_ts: null, author: "a person Vasquez", text: "lights up all three views. table is always there as floor. honestly feels right", ts: ago(38 * MIN), reactions: [{emoji: "💯", count: 2}], is_dm: false },
  { id: rid("sl"), channel: "#design", channel_id: "C02", thread_ts: null, author: "Maya Chen", text: "draft of the grant strip is in figma — i went with the always-visible variant. the dismissable one felt like an ad", ts: ago(3 * HOUR), reactions: [{emoji: "✅", count: 4}], is_dm: false },
  { id: rid("sl"), channel: "#design", channel_id: "C02", thread_ts: null, author: "Drew Park", text: "agree. one note: the expires-in countdown should be subtle, not loud. red only in the last 24h", ts: ago(2 * HOUR + 50 * MIN), reactions: [{emoji: "👍", count: 2}], is_dm: false },
  { id: rid("sl"), channel: "#general", channel_id: "C00", thread_ts: null, author: "a person Vasquez", text: "reminder: launch readiness sync tomorrow 10:30, not 9. agenda doc is open for additions", ts: ago(5 * HOUR), reactions: [{emoji: "🗓️", count: 7}], is_dm: false },
  { id: rid("sl"), channel: "DM with Maya Chen", channel_id: "D01", thread_ts: null, author: "Maya Chen", text: "do you want me to bring the redlines printed thursday or just on screen?", ts: ago(1 * DAY + 2 * HOUR), reactions: [], is_dm: true },
  { id: rid("sl"), channel: "DM with Maya Chen", channel_id: "D01", thread_ts: null, author: "the owner Nunamaker", text: "screen is fine. coffee plan stands?", ts: ago(1 * DAY + 1 * HOUR + 50 * MIN), reactions: [{emoji: "☕", count: 1}], is_dm: true },
  { id: rid("sl"), channel: "DM with Maya Chen", channel_id: "D01", thread_ts: null, author: "Maya Chen", text: "yep. ritual @ 1:30. see you there", ts: ago(1 * DAY + 1 * HOUR + 45 * MIN), reactions: [], is_dm: true },
  { id: rid("sl"), channel: "#eng-platform", channel_id: "C01", thread_ts: null, author: "Drew Park", text: "btw the openapi spec for /v1/search now has the mode enum — lexical/semantic/hybrid. backwards compatible, mode is optional, defaults to lexical", ts: ago(1 * DAY + 6 * HOUR), reactions: [{emoji: "📘", count: 2}], is_dm: false },
  { id: rid("sl"), channel: "#eng-platform", channel_id: "C01", thread_ts: null, author: "the owner Nunamaker", text: "the explorer is going to expose that as a pill in command-K. \"lex / sem / hybrid\". feels right", ts: ago(1 * DAY + 5 * HOUR + 30 * MIN), reactions: [{emoji: "💡", count: 1}], is_dm: false },
  { id: rid("sl"), channel: "#general", channel_id: "C00", thread_ts: null, author: "Drew Park", text: "tara from longview shipped the demo client. it's running against our sandbox AS. genuinely cool to see external code requesting a scoped grant", ts: ago(2 * DAY), reactions: [{emoji: "🎉", count: 9}, {emoji: "🔥", count: 4}], is_dm: false },
  { id: rid("sl"), channel: "#design", channel_id: "C02", thread_ts: null, author: "Maya Chen", text: "should the home screen lead with memories or with the heatmap? i keep flipping", ts: ago(2 * DAY + 4 * HOUR), reactions: [], is_dm: false },
  { id: rid("sl"), channel: "#design", channel_id: "C02", thread_ts: null, author: "the owner Nunamaker", text: "memories. heatmap is dense — better as a second-fold module. memories is what you want to *open* the app for", ts: ago(2 * DAY + 3 * HOUR + 55 * MIN), reactions: [{emoji: "✨", count: 3}], is_dm: false },
  { id: rid("sl"), channel: "#random", channel_id: "C03", thread_ts: null, author: "Drew Park", text: "hattie laid a green egg apparently. the owner has photographic evidence", ts: ago(2 * DAY + 8 * HOUR), reactions: [{emoji: "🥚", count: 6}, {emoji: "🐔", count: 4}], is_dm: false },
  { id: rid("sl"), channel: "DM with a person Vasquez", channel_id: "D02", thread_ts: null, author: "a person Vasquez", text: "are you good to demo the explorer at the IETF thing wed? 15 min slot, second half can be Q&A", ts: ago(3 * DAY), reactions: [], is_dm: true },
  { id: rid("sl"), channel: "DM with a person Vasquez", channel_id: "D02", thread_ts: null, author: "the owner Nunamaker", text: "yes. i'll lead with the field-projection toggle. that's the moment.", ts: ago(3 * DAY - 10 * MIN), reactions: [{emoji: "💪", count: 1}], is_dm: true },
  { id: rid("sl"), channel: "#general", channel_id: "C00", thread_ts: null, author: "a person Vasquez", text: "spec working group put out 0.9-rc1. our reference impl validates clean against it. one minor breaking change in /v1/search results shape — drew's PR covers it", ts: ago(5 * DAY), reactions: [{emoji: "📦", count: 5}], is_dm: false },
  { id: rid("sl"), channel: "#eng-platform", channel_id: "C01", thread_ts: null, author: "Maya Chen", text: "is anyone else seeing the chase connector eat its 2FA cookie between runs? it's been every-time-otp for two weeks", ts: ago(6 * DAY), reactions: [{emoji: "😩", count: 2}], is_dm: false },
  { id: rid("sl"), channel: "#eng-platform", channel_id: "C01", thread_ts: null, author: "Drew Park", text: "yeah — _tmprememberme is session-only. there's an open PR. it's a chase-side change in how they set the cookie", ts: ago(6 * DAY - 5 * MIN), reactions: [{emoji: "🔍", count: 1}], is_dm: false },
];

// CHASE ─────────────────────────────────────────────────────────────────
const chaseFields = [
  { name: "id",         type: "id",        granted: true },
  { name: "account_id", type: "id",        granted: true },
  { name: "posted_at",  type: "timestamp", granted: true },
  { name: "merchant",   type: "text",      granted: true },
  { name: "category",   type: "enum",      granted: true },
  { name: "amount",     type: "currency",  granted: true, currency: "USD" },
  { name: "balance_after", type: "currency", granted: false, redacted_reason: "running balance not in grant" },
  { name: "memo",       type: "text",      granted: true },
];
const chaseViews = ["all", "this_month", "by_category", "large_only"];

const chaseRecords = [
  { id: rid("ch"), account_id: "•6432", posted_at: ago(6 * HOUR),       merchant: "Blue Bottle Coffee — Mint Plaza", category: "Food & Drink", amount: -5.75,  memo: "" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(1 * DAY + 2*HOUR), merchant: "Trader Joe's", category: "Groceries",         amount: -67.42, memo: "" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(1 * DAY + 8*HOUR), merchant: "Caltrain · Mobile",  category: "Transit",   amount: -7.00,  memo: "Mountain View → 22nd St" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(2 * DAY),         merchant: "Ritual Coffee Roasters", category: "Food & Drink", amount: -4.50, memo: "" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(3 * DAY),         merchant: "Pacific Gas & Electric", category: "Utilities", amount: -118.34, memo: "Bill payment" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(4 * DAY),         merchant: "Whole Foods",       category: "Groceries", amount: -84.19, memo: "" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(4 * DAY + 3*HOUR), merchant: "Lyft · Ride",      category: "Transit",   amount: -14.20, memo: "Mission → Outer Sunset" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(5 * DAY),         merchant: "Apple Store — Stockton St", category: "Electronics", amount: -487.14, memo: "AirPods Max" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(6 * DAY),         merchant: "Stripe — Payroll Deposit", category: "Income", amount: 4_872.00, memo: "Vana May 1-15" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(7 * DAY),         merchant: "Rainbow Grocery",   category: "Groceries", amount: -31.07, memo: "" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(9 * DAY),         merchant: "Comcast Internet",  category: "Utilities", amount: -89.99, memo: "" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(10 * DAY),        merchant: "Tartine Bakery",    category: "Food & Drink", amount: -12.50, memo: "" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(11 * DAY),        merchant: "Costco Wholesale",  category: "Groceries", amount: -213.47, memo: "" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(13 * DAY),        merchant: "Amazon.com",        category: "Shopping",  amount: -42.18, memo: "Books" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(15 * DAY),        merchant: "Chevron · Castro",  category: "Transit",   amount: -52.40, memo: "" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(17 * DAY),        merchant: "ACLU of Northern California", category: "Donations", amount: -25.00, memo: "Monthly" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(20 * DAY),        merchant: "Stripe — Payroll Deposit", category: "Income", amount: 4_872.00, memo: "Vana April 16-30" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(22 * DAY),        merchant: "Bi-Rite Market",    category: "Groceries", amount: -38.91, memo: "" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(24 * DAY),        merchant: "Hayes Valley Bakeworks", category: "Food & Drink", amount: -8.75, memo: "" },
  { id: rid("ch"), account_id: "•6432", posted_at: ago(26 * DAY),        merchant: "Anthropic — Claude Pro", category: "Subscriptions", amount: -20.00, memo: "" },
];

// AMAZON ────────────────────────────────────────────────────────────────
const amazonFields = [
  { name: "id",          type: "id",         granted: true },
  { name: "ordered_at",  type: "timestamp",  granted: true },
  { name: "title",       type: "text",       granted: true },
  { name: "merchant",    type: "text",       granted: true },
  { name: "amount",      type: "currency",   granted: true, currency: "USD" },
  { name: "thumbnail",   type: "blob",       granted: true, media_type: "image/jpeg" },
  { name: "status",      type: "enum",       granted: true },
  { name: "tracking_id", type: "id",         granted: false, redacted_reason: "out of scope" },
];
const amazonViews = ["all", "this_year", "by_seller"];

const amazonRecords = [
  { id: rid("az"), ordered_at: ago(2 * DAY),  title: "Hario V60 Plastic Coffee Dripper, Size 02", merchant: "Hario Direct", amount: -14.99, thumbnail: "https://picsum.photos/seed/hario/240", status: "Delivered" },
  { id: rid("az"), ordered_at: ago(6 * DAY),  title: "DK Bicycles Crank Brothers Eggbeater 3 Pedals", merchant: "Crank Brothers", amount: -129.95, thumbnail: "https://picsum.photos/seed/pedal/240", status: "Delivered" },
  { id: rid("az"), ordered_at: ago(11 * DAY), title: "Anker 737 Power Bank 24,000mAh 140W USB-C", merchant: "AnkerDirect", amount: -89.99, thumbnail: "https://picsum.photos/seed/anker/240", status: "Delivered" },
  { id: rid("az"), ordered_at: ago(13 * DAY), title: "The Address Book by Sophie Calle", merchant: "Siglio Press", amount: -42.18, thumbnail: "https://picsum.photos/seed/book/240", status: "Delivered" },
  { id: rid("az"), ordered_at: ago(18 * DAY), title: "Field Notes Original Kraft 3-Pack (Graph)", merchant: "Field Notes Brand", amount: -12.95, thumbnail: "https://picsum.photos/seed/fieldnotes/240", status: "Delivered" },
  { id: rid("az"), ordered_at: ago(22 * DAY), title: "Stanley IceFlow Flip Straw Tumbler 30oz", merchant: "Stanley", amount: -35.00, thumbnail: "https://picsum.photos/seed/stanley/240", status: "Delivered" },
];

// GITHUB ────────────────────────────────────────────────────────────────
const githubFields = [
  { name: "id",         type: "id",        granted: true },
  { name: "type",       type: "enum",      granted: true },
  { name: "repo",       type: "text",      granted: true },
  { name: "title",      type: "text",      granted: true },
  { name: "body",       type: "text",      granted: true },
  { name: "actor",      type: "person",    granted: true },
  { name: "created_at", type: "timestamp", granted: true },
  { name: "url",        type: "url",       granted: true },
  { name: "additions",  type: "number",    granted: true },
  { name: "deletions",  type: "number",    granted: true },
];
const githubViews = ["all", "commits", "prs", "issues"];

const githubRecords = [
  { id: rid("gh"), type: "PullRequest",   repo: "vana-com/pdpp",   title: "explorer: capability dispatch + tier-1 table view", body: "Implements the schema-signal dispatch we discussed. Streams now declare typed fields and the explorer infers timeline/map/gallery/ledger/conversation/calendar/reader/chart eligibility from the fields, not the connector id.", actor: "owner", created_at: ago(3 * HOUR), url: "https://github.com/vana-com/pdpp/pull/851", additions: 712, deletions: 184 },
  { id: rid("gh"), type: "Push",          repo: "vana-com/pdpp",   title: "fix: peek panel respects field projection toggle", body: "Was showing all fields regardless of grant.", actor: "owner", created_at: ago(8 * HOUR), url: "https://github.com/vana-com/pdpp/commit/a47c2d1", additions: 28, deletions: 12 },
  { id: rid("gh"), type: "PullRequest",   repo: "vana-com/pdpp",   title: "search: expose mode (lexical/semantic/hybrid)", body: "Propagates the new search mode enum through MCP and the dashboard search view.", actor: "drewpark", created_at: ago(1 * DAY + 2 * HOUR), url: "https://github.com/vana-com/pdpp/pull/848", additions: 412, deletions: 89 },
  { id: rid("gh"), type: "PullRequest",   repo: "vana-com/pdpp",   title: "[merged] capability dispatch in explorer", body: "First version of the dispatch + table fallback. Connector-specific layouts will land in follow-up PRs.", actor: "mayachen", created_at: ago(6 * DAY), url: "https://github.com/vana-com/pdpp/pull/847", additions: 482, deletions: 137 },
  { id: rid("gh"), type: "Issue",         repo: "vana-com/pdpp",   title: "chase connector loses trusted-device cookie between runs", body: "Every run requires fresh SMS OTP. Suspect _tmprememberme is session-only.", actor: "owner", created_at: ago(6 * DAY + 4 * HOUR), url: "https://github.com/vana-com/pdpp/issues/843", additions: 0, deletions: 0 },
  { id: rid("gh"), type: "Push",          repo: "owner/clawmeter", title: "0.4.2: nicer histogram colors", body: "Use copper for the bars and grey for the baseline.", actor: "owner", created_at: ago(9 * DAY), url: "https://github.com/owner/clawmeter/commit/9d7e3a2", additions: 14, deletions: 8 },
  { id: rid("gh"), type: "PullRequest",   repo: "vana-com/pdpp",   title: "polyfill-connectors: scaffold loom + linkedin", body: "Manifest + connector shell only; selectors TBD with live co-pilot session.", actor: "owner", created_at: ago(12 * DAY), url: "https://github.com/vana-com/pdpp/pull/831", additions: 348, deletions: 0 },
  { id: rid("gh"), type: "Issue",         repo: "vana-com/pdpp",   title: "MCP `search` mode pill not surfaced in agent skill", body: "We added the enum but the Claude skill instructions still pin mode=lexical.", actor: "annavasquez", created_at: ago(15 * DAY), url: "https://github.com/vana-com/pdpp/issues/827", additions: 0, deletions: 0 },
  { id: rid("gh"), type: "Push",          repo: "owner/dotfiles", title: "switch shell to ghostty + nushell", body: "no regrets", actor: "owner", created_at: ago(19 * DAY), url: "https://github.com/owner/dotfiles/commit/0c8a91f", additions: 84, deletions: 142 },
  { id: rid("gh"), type: "PullRequest",   repo: "vana-com/pdpp",   title: "docs: human/protocol duality writeup", body: "Adds README section on the 2px copper-vs-blue temperature system.", actor: "mayachen", created_at: ago(23 * DAY), url: "https://github.com/vana-com/pdpp/pull/814", additions: 187, deletions: 14 },
];

// STRAVA ────────────────────────────────────────────────────────────────
const stravaFields = [
  { name: "id",         type: "id",         granted: true },
  { name: "type",       type: "enum",       granted: true },
  { name: "title",      type: "text",       granted: true },
  { name: "started_at", type: "timestamp",  granted: true },
  { name: "distance_m", type: "number",     granted: true, unit: "meters" },
  { name: "duration_s", type: "number",     granted: true, unit: "seconds" },
  { name: "elev_m",     type: "number",     granted: true, unit: "meters" },
  { name: "start_lat",  type: "number",     granted: true },
  { name: "start_lng",  type: "number",     granted: true },
  { name: "polyline",   type: "geo",        granted: false, redacted_reason: "route geometry not in grant" },
];
const stravaViews = ["all", "runs", "rides", "this_month"];

const stravaRecords = [
  { id: rid("st"), type: "Run", title: "Lunch trail loop · Glen Canyon", started_at: ago(7 * HOUR), distance_m: 8_240, duration_s: 2_730, elev_m: 187, start_lat: 37.7390, start_lng: -122.4408 },
  { id: rid("st"), type: "Ride", title: "Marin Headlands · Hawk Hill", started_at: ago(2 * DAY + 4 * HOUR), distance_m: 38_700, duration_s: 6_840, elev_m: 612, start_lat: 37.8324, start_lng: -122.4795 },
  { id: rid("st"), type: "Run", title: "Easy shakeout — Mission Dolores", started_at: ago(3 * DAY + 7 * HOUR), distance_m: 5_080, duration_s: 1_680, elev_m: 41, start_lat: 37.7585, start_lng: -122.4263 },
  { id: rid("st"), type: "Run", title: "Sunday long — Lands End", started_at: ago(5 * DAY + 8 * HOUR), distance_m: 18_120, duration_s: 6_180, elev_m: 284, start_lat: 37.7820, start_lng: -122.5060 },
  { id: rid("st"), type: "Ride", title: "Commute · Mission → Soma", started_at: ago(6 * DAY + 1 * HOUR), distance_m: 4_310, duration_s: 1_080, elev_m: 28, start_lat: 37.7599, start_lng: -122.4147 },
  { id: rid("st"), type: "Run", title: "Track Tuesday — 6x800", started_at: ago(8 * DAY + 7 * HOUR), distance_m: 9_600, duration_s: 2_810, elev_m: 12, start_lat: 37.7311, start_lng: -122.4470 },
  { id: rid("st"), type: "Ride", title: "Sausalito ferry loop", started_at: ago(11 * DAY + 9 * HOUR), distance_m: 52_400, duration_s: 9_120, elev_m: 487, start_lat: 37.8086, start_lng: -122.4108 },
  { id: rid("st"), type: "Run", title: "Recovery — Bernal Heights", started_at: ago(13 * DAY + 8 * HOUR), distance_m: 4_700, duration_s: 1_620, elev_m: 91, start_lat: 37.7430, start_lng: -122.4140 },
  { id: rid("st"), type: "Run", title: "Hill repeats — Sanchez stairs", started_at: ago(15 * DAY + 7 * HOUR), distance_m: 6_800, duration_s: 2_280, elev_m: 312, start_lat: 37.7510, start_lng: -122.4291 },
  { id: rid("st"), type: "Ride", title: "GG Park to Ocean Beach", started_at: ago(18 * DAY + 10 * HOUR), distance_m: 14_200, duration_s: 2_640, elev_m: 78, start_lat: 37.7694, start_lng: -122.4862 },
  { id: rid("st"), type: "Run", title: "Crissy Field flat", started_at: ago(22 * DAY + 7 * HOUR), distance_m: 7_300, duration_s: 2_460, elev_m: 22, start_lat: 37.8030, start_lng: -122.4660 },
  { id: rid("st"), type: "Run", title: "Long — Presidio loop", started_at: ago(26 * DAY + 8 * HOUR), distance_m: 16_400, duration_s: 5_700, elev_m: 198, start_lat: 37.7989, start_lng: -122.4662 },
];

// PHOTOS ────────────────────────────────────────────────────────────────
const photosFields = [
  { name: "id",          type: "id",        granted: true },
  { name: "taken_at",    type: "timestamp", granted: true },
  { name: "caption",     type: "text",      granted: true },
  { name: "thumbnail",   type: "blob",      granted: true, media_type: "image/jpeg" },
  { name: "lat",         type: "number",    granted: true },
  { name: "lng",         type: "number",    granted: true },
  { name: "camera",      type: "text",      granted: false, redacted_reason: "EXIF stripped — out of scope" },
  { name: "people",      type: "person[]",  granted: false, redacted_reason: "face-detection metadata not in grant" },
];
const photosViews = ["all", "this_month", "starred", "by_place"];

const photosRecords = [
  { id: rid("ph"), taken_at: ago(6 * HOUR),       caption: "morning light, kitchen", thumbnail: "https://picsum.photos/seed/morn-light/600", lat: 37.7599, lng: -122.4147 },
  { id: rid("ph"), taken_at: ago(1 * DAY + 4*HOUR), caption: "trail above Glen Park", thumbnail: "https://picsum.photos/seed/glen-trail/600", lat: 37.7390, lng: -122.4408 },
  { id: rid("ph"), taken_at: ago(2 * DAY + 8*HOUR), caption: "the green egg", thumbnail: "https://picsum.photos/seed/green-egg/600", lat: 39.5296, lng: -119.8138 },
  { id: rid("ph"), taken_at: ago(3 * DAY),         caption: "a person's whiteboard sketch", thumbnail: "https://picsum.photos/seed/whiteboard/600", lat: 37.7794, lng: -122.4078 },
  { id: rid("ph"), taken_at: ago(4 * DAY + 7*HOUR), caption: "fog rolling in, twin peaks", thumbnail: "https://picsum.photos/seed/fog-tp/600", lat: 37.7544, lng: -122.4477 },
  { id: rid("ph"), taken_at: ago(6 * DAY),         caption: "espresso, ritual", thumbnail: "https://picsum.photos/seed/espresso/600", lat: 37.7765, lng: -122.4243 },
  { id: rid("ph"), taken_at: ago(8 * DAY),         caption: "bike against the wall", thumbnail: "https://picsum.photos/seed/bike-wall/600", lat: 37.7599, lng: -122.4147 },
  { id: rid("ph"), taken_at: ago(11 * DAY + 9*HOUR), caption: "sausalito, mid ferry", thumbnail: "https://picsum.photos/seed/ferry/600", lat: 37.8590, lng: -122.4853 },
  { id: rid("ph"), taken_at: ago(14 * DAY),        caption: "library window", thumbnail: "https://picsum.photos/seed/library/600", lat: 37.7793, lng: -122.4162 },
  { id: rid("ph"), taken_at: ago(17 * DAY),        caption: "wet hydrant, Castro", thumbnail: "https://picsum.photos/seed/hydrant/600", lat: 37.7609, lng: -122.4351 },
  { id: rid("ph"), taken_at: ago(20 * DAY),        caption: "yellow door, Mission", thumbnail: "https://picsum.photos/seed/yellow-door/600", lat: 37.7595, lng: -122.4148 },
  { id: rid("ph"), taken_at: ago(25 * DAY),        caption: "old MUNI signal", thumbnail: "https://picsum.photos/seed/muni-sig/600", lat: 37.7707, lng: -122.4316 },
];

// OURA ──────────────────────────────────────────────────────────────────
const ouraFields = [
  { name: "id",          type: "id",        granted: true },
  { name: "night_of",    type: "timestamp", granted: true },
  { name: "score",       type: "number",    granted: true, unit: "0-100" },
  { name: "deep_min",    type: "number",    granted: true, unit: "minutes" },
  { name: "rem_min",     type: "number",    granted: true, unit: "minutes" },
  { name: "light_min",   type: "number",    granted: true, unit: "minutes" },
  { name: "hrv_ms",      type: "number",    granted: true, unit: "ms" },
  { name: "resting_hr",  type: "number",    granted: true, unit: "bpm" },
];
const ouraViews = ["all", "this_month", "low_score"];

const ouraRecords = Array.from({length: 14}, (_, i) => ({
  id: rid("ou"),
  night_of: ago((i + 1) * DAY - 6 * HOUR),
  score: [82, 76, 88, 91, 71, 79, 85, 84, 67, 73, 88, 92, 80, 74][i],
  deep_min: [62, 51, 78, 81, 42, 58, 71, 69, 38, 47, 74, 82, 64, 49][i],
  rem_min:  [108, 94, 121, 134, 81, 99, 117, 115, 73, 88, 119, 128, 105, 92][i],
  light_min: [212, 198, 234, 247, 174, 201, 226, 224, 165, 188, 230, 241, 218, 196][i],
  hrv_ms:   [48, 42, 56, 61, 38, 44, 52, 51, 34, 41, 55, 59, 47, 43][i],
  resting_hr: [54, 56, 51, 50, 58, 55, 52, 53, 60, 57, 51, 50, 54, 56][i],
}));

// CALENDAR (iCal) ───────────────────────────────────────────────────────
const calendarFields = [
  { name: "id",       type: "id",        granted: true },
  { name: "title",    type: "text",      granted: true },
  { name: "start",    type: "timestamp", granted: true },
  { name: "end",      type: "timestamp", granted: true },
  { name: "location", type: "text",      granted: true },
  { name: "attendees", type: "person[]", granted: true },
  { name: "description", type: "text",   granted: false, redacted_reason: "description excluded by grant" },
];
const calendarViews = ["upcoming", "all", "this_week"];

const calendarRecords = [
  { id: rid("cal"), title: "Standup",                            start: at(NOW + 14 * HOUR),     end: at(NOW + 14.5 * HOUR), location: "Zoom",            attendees: ["a person Vasquez","Maya Chen","Drew Park","the owner Nunamaker"] },
  { id: rid("cal"), title: "Coffee w/ Maya",                     start: at(NOW + 1 * DAY + 6 * HOUR),  end: at(NOW + 1 * DAY + 7 * HOUR), location: "Ritual Coffee Mission", attendees: ["Maya Chen","the owner Nunamaker"] },
  { id: rid("cal"), title: "Portfolio review w/ Maya",           start: at(NOW + 3 * DAY + 5 * HOUR),  end: at(NOW + 3 * DAY + 6 * HOUR), location: "Figma SF",              attendees: ["Maya Chen","the owner Nunamaker"] },
  { id: rid("cal"), title: "PDPP biweekly",                      start: at(NOW + 3 * DAY + 11 * HOUR), end: at(NOW + 3 * DAY + 11.5 * HOUR), location: "Zoom",          attendees: ["a person Vasquez","Maya Chen","Drew Park","the owner Nunamaker"] },
  { id: rid("cal"), title: "Flight SFO → AUS (Southwest L4M2QP)", start: at(NOW + 7 * DAY + 6.5 * HOUR), end: at(NOW + 7 * DAY + 10 * HOUR), location: "SFO Terminal 1",     attendees: [] },
  { id: rid("cal"), title: "Dentist · Dr. Mei",                  start: at(NOW + 9 * DAY + 9 * HOUR),  end: at(NOW + 9 * DAY + 10 * HOUR), location: "1700 Castro St",     attendees: [] },
];

// ─── deep-time synthetic records ────────────────────────────────────
// Seeded records spanning ~8 years so the year strip / memories have
// substance to render against. Real users would have ~10× this.

const Y = (year, month, day, hour = 12) => new Date(Date.UTC(year, month - 1, day, hour, 0)).toISOString();

const deepGmail = [
  { id: rid("gm"), thread_id: "th1", from: "Maya Chen <maya.chen@figma.com>", to: ["the owner@nunamak.com"], subject: "happy birthday old man", snippet: "hope it's a good one. drinks tomorrow at zeitgeist?", date: Y(2025, 5, 24, 9), labels: ["Inbox", "Starred"], has_attachment: false },
  { id: rid("gm"), thread_id: "th2", from: "United Airlines <flights@united.com>", to: ["the owner@nunamak.com"], subject: "Your flight to Tokyo on May 24 is confirmed", snippet: "SFO → NRT · UA837 · 11:40am · seat 14A", date: Y(2024, 5, 24, 7), labels: ["Inbox", "Travel"], has_attachment: true },
  { id: rid("gm"), thread_id: "th3", from: "a person Vasquez <a person@vana.org>", to: ["the owner@nunamak.com"], subject: "welcome to vana", snippet: "the owner — so glad to have you on board. Here's everything you need for your first week.", date: Y(2023, 8, 14, 10), labels: ["Inbox", "Important"], has_attachment: true },
  { id: rid("gm"), thread_id: "th4", from: "Apple <noreply@apple.com>", to: ["the owner@nunamak.com"], subject: "Your iPhone 13 is ready for pickup", snippet: "Order #W4729103 · Apple Store Stockton St", date: Y(2022, 9, 24, 14), labels: ["Inbox", "Receipts"], has_attachment: false },
  { id: rid("gm"), thread_id: "th5", from: "mom <ellen.nunamaker@gmail.com>", to: ["the owner@nunamak.com"], subject: "the new puppy!!", snippet: "we named her hattie. sending all the photos.", date: Y(2021, 4, 11, 17), labels: ["Inbox"], has_attachment: true },
  { id: rid("gm"), thread_id: "th6", from: "Square <receipts@squareup.com>", to: ["the owner@nunamak.com"], subject: "Receipt from Ritual Coffee", snippet: "$4.50 · cortado · Tip $1.00", date: Y(2020, 3, 7, 9), labels: ["Inbox", "Receipts"], has_attachment: false },
  { id: rid("gm"), thread_id: "th7", from: "OkCupid <noreply@okcupid.com>", to: ["the owner@nunamak.com"], subject: "You have a new match", snippet: "Someone liked you back. Open the app to chat.", date: Y(2019, 7, 22, 20), labels: ["Inbox"], has_attachment: false },
  { id: rid("gm"), thread_id: "th8", from: "Stanford Alumni <alumni@stanford.edu>", to: ["the owner@nunamak.com"], subject: "Class of 2014 — 5-year reunion", snippet: "Save the date: October 19, 2019. Memorial Auditorium.", date: Y(2018, 11, 2, 11), labels: ["Inbox"], has_attachment: false },
];

const deepPhotos = [
  { id: rid("ph"), taken_at: Y(2025, 5, 24, 9), caption: "birthday morning", thumbnail: "https://picsum.photos/seed/bd25/600", lat: 37.7599, lng: -122.4147 },
  { id: rid("ph"), taken_at: Y(2024, 5, 24, 14), caption: "shinjuku at noon", thumbnail: "https://picsum.photos/seed/tokyo24/600", lat: 35.6895, lng: 139.6917 },
  { id: rid("ph"), taken_at: Y(2023, 12, 31, 22), caption: "NYE rooftop", thumbnail: "https://picsum.photos/seed/nye23/600", lat: 37.7749, lng: -122.4194 },
  { id: rid("ph"), taken_at: Y(2022, 9, 24, 15), caption: "new phone, first photo", thumbnail: "https://picsum.photos/seed/iph22/600", lat: 37.7768, lng: -122.4063 },
  { id: rid("ph"), taken_at: Y(2021, 4, 11, 18), caption: "hattie, first day home", thumbnail: "https://picsum.photos/seed/hattie/600", lat: 39.5296, lng: -119.8138 },
  { id: rid("ph"), taken_at: Y(2020, 6, 18, 19), caption: "balcony tomatoes, year 1", thumbnail: "https://picsum.photos/seed/toms/600", lat: 37.7599, lng: -122.4147 },
  { id: rid("ph"), taken_at: Y(2019, 8, 4, 16), caption: "trout, Yellowstone", thumbnail: "https://picsum.photos/seed/yst19/600", lat: 44.4280, lng: -110.5885 },
  { id: rid("ph"), taken_at: Y(2018, 6, 16, 12), caption: "graduation day", thumbnail: "https://picsum.photos/seed/grad18/600", lat: 37.4275, lng: -122.1697 },
];

const deepChase = [
  { id: rid("ch"), account_id: "•6432", posted_at: Y(2025, 5, 24, 21), merchant: "Zeitgeist", category: "Food & Drink", amount: -38.00, memo: "" },
  { id: rid("ch"), account_id: "•6432", posted_at: Y(2024, 5, 24, 11), merchant: "United Airlines", category: "Travel", amount: -1_482.00, memo: "SFO → NRT" },
  { id: rid("ch"), account_id: "•6432", posted_at: Y(2022, 9, 24, 14), merchant: "Apple Store — Stockton St", category: "Electronics", amount: -1_099.00, memo: "iPhone 13" },
  { id: rid("ch"), account_id: "•6432", posted_at: Y(2020, 6, 14, 9), merchant: "Sloat Garden Center", category: "Home", amount: -84.40, memo: "soil, tomato cages" },
  { id: rid("ch"), account_id: "•6432", posted_at: Y(2018, 8, 1, 10), merchant: "Stripe — Payroll Deposit", category: "Income", amount: 3_200.00, memo: "first paycheck" },
];

const deepGithub = [
  { id: rid("gh"), type: "PullRequest", repo: "vana-com/pdpp", title: "init repo, README", body: "Hello world.", actor: "owner", created_at: Y(2023, 9, 1, 14), url: "https://github.com/vana-com/pdpp/pull/1", additions: 412, deletions: 0 },
  { id: rid("gh"), type: "Push", repo: "owner/dotfiles", title: "first commit", body: "", actor: "owner", created_at: Y(2018, 7, 14, 21), url: "", additions: 87, deletions: 0 },
  { id: rid("gh"), type: "PullRequest", repo: "owner/clawmeter", title: "0.1.0 — initial release", body: "", actor: "owner", created_at: Y(2020, 11, 19, 16), url: "", additions: 1_482, deletions: 0 },
];

gmailPersonalRecords.push(...deepGmail);
photosRecords.push(...deepPhotos);
chaseRecords.push(...deepChase);
githubRecords.push(...deepGithub);

// ─── assembled streams ─────────────────────────────────────────────────
const streams = [
  {
    name: "messages", connector_id: "gmail", connection_id: "c_gmail_p",
    title: "Gmail · personal", icon: "✉", connection_display: "the owner@nunamak.com",
    record_count: 27_359, latest_at: gmailPersonalRecords[0].date,
    schema: { fields: gmailFields, views: gmailViews },
    records: gmailPersonalRecords,
  },
  {
    name: "messages", connector_id: "gmail", connection_id: "c_gmail_w",
    title: "Gmail · work", icon: "✉", connection_display: "the owner@vana.org",
    record_count: 8_412, latest_at: gmailWorkRecords[0].date,
    schema: { fields: gmailFields, views: gmailViews },
    records: gmailWorkRecords,
  },
  {
    name: "messages", connector_id: "slack", connection_id: "c_slack",
    title: "Slack · vana", icon: "▤", connection_display: "vana.slack.com",
    record_count: 14_028, latest_at: slackRecords[0].ts,
    schema: { fields: slackFields, views: slackViews },
    records: slackRecords,
  },
  {
    name: "transactions", connector_id: "chase", connection_id: "c_chase",
    title: "Chase · •6432", icon: "$", connection_display: "•6432",
    record_count: 1_482, latest_at: chaseRecords[0].posted_at,
    schema: { fields: chaseFields, views: chaseViews },
    records: chaseRecords,
  },
  {
    name: "orders", connector_id: "amazon", connection_id: "c_amazon",
    title: "Amazon · orders", icon: "▪", connection_display: "the owner@nunamak.com",
    record_count: 2_863, latest_at: amazonRecords[0].ordered_at,
    schema: { fields: amazonFields, views: amazonViews },
    records: amazonRecords,
  },
  {
    name: "events", connector_id: "github", connection_id: "c_github",
    title: "GitHub · owner", icon: "<>", connection_display: "owner",
    record_count: 553, latest_at: githubRecords[0].created_at,
    schema: { fields: githubFields, views: githubViews },
    records: githubRecords,
  },
  {
    name: "activities", connector_id: "strava", connection_id: "c_strava",
    title: "Strava · activities", icon: "↗", connection_display: "the owner Nunamaker",
    record_count: 412, latest_at: stravaRecords[0].started_at,
    schema: { fields: stravaFields, views: stravaViews },
    records: stravaRecords,
  },
  {
    name: "media", connector_id: "google_takeout", connection_id: "c_photos",
    title: "Photos · Takeout", icon: "□", connection_display: "the owner@nunamak.com",
    record_count: 18_240, latest_at: photosRecords[0].taken_at,
    schema: { fields: photosFields, views: photosViews },
    records: photosRecords,
  },
  {
    name: "sleep", connector_id: "oura", connection_id: "c_oura",
    title: "Oura · sleep", icon: "○", connection_display: "Ring Gen3",
    record_count: 421, latest_at: ouraRecords[0].night_of,
    schema: { fields: ouraFields, views: ouraViews },
    records: ouraRecords,
  },
  {
    name: "events", connector_id: "ical", connection_id: "c_ical",
    title: "Calendar · personal", icon: "▭", connection_display: "personal.ics",
    record_count: 312, latest_at: calendarRecords[0].start,
    schema: { fields: calendarFields, views: calendarViews },
    records: calendarRecords,
  },
];

window.PDPP_DATA = { grant, connections, streams, now: NOW };
