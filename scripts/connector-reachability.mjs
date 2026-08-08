#!/usr/bin/env node
// Unauthenticated reachability probe for connector API paths.
//
// WHY THIS EXISTS
// The Jellyfin connector shipped 100% broken with every test green. It prefixed
// every request with `/api/`, but Jellyfin serves its API at the root. Its tests
// asserted on `"/api/Users/Me"` — the mocks encoded the SAME mistake as the
// implementation, because the same author wrote both. A unit suite structurally
// cannot catch that: it only ever proves the code agrees with itself.
//
// A real HTTP request settles it without any credential:
//     404 -> the path does not exist        (the Jellyfin bug)
//     401/403 -> the path exists, needs auth (correct shape)
// That single distinction is the cheapest possible check for the most damaging
// class of connector bug, and it needs no secrets.
//
// LIMITS, stated plainly:
//   - Needs network. Cannot run in a hermetic CI sandbox; run it nightly or as an
//     opt-in job, never as a blocking unit test.
//   - Only covers connectors with a FIXED, public API base. A self-hosted
//     connector (Jellyfin, Nextcloud) needs the owner's own host, so it reports
//     NEEDS_HOST unless one is supplied.
//   - A 200 on an unauthenticated request is NOT proof of correctness. It usually
//     means a public endpoint, sometimes a login redirect. Reported as INFO.
//   - It never proves a connector WORKS. It only refutes a wrong path.
//
// Usage:
//   node scripts/connector-reachability.mjs
//   node scripts/connector-reachability.mjs --json
//   JELLYFIN_BASE_URL=https://jellyfin.example node scripts/connector-reachability.mjs
//
// Exit 0 always unless --strict: this is a REPORT, not a gate. 34 of 42
// connectors are unproven today; a blocking gate would stop all work.

const JSON_OUT = process.argv.includes("--json");
const STRICT = process.argv.includes("--strict");
const TIMEOUT_MS = 12_000;

/**
 * Probe targets. Each entry names an endpoint the connector genuinely requests,
 * chosen so an unauthenticated call is expected to be REFUSED (401/403) rather
 * than served — that refusal is the proof the path exists.
 *
 * `expect: "refused"` — a 401/403 proves the path is real.
 * `expect: "served"`  — a documented public endpoint; 200 is correct.
 * `method` — defaults to GET; some real request shapes need POST/PROPFIND.
 * Self-hosted connectors carry `baseEnv` and are skipped unless it is set.
 *
 * Every URL below is the connector's OWN request, read from its source
 * (file:line noted per entry) — not from provider documentation — so this
 * probe tests what the code actually does, not what the docs say it should.
 */
const TARGETS = [
  {
    connector: "steam",
    name: "ISteamUser/GetPlayerSummaries",
    url: "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/",
    expect: "refused",
  },
  {
    connector: "steam",
    name: "IPlayerService/GetOwnedGames",
    url: "https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/",
    expect: "refused",
  },
  { connector: "groupme", name: "v3/groups", url: "https://api.groupme.com/v3/groups", expect: "refused" },
  { connector: "github", name: "user", url: "https://api.github.com/user", expect: "refused" },
  { connector: "notion", name: "v1/users/me", url: "https://api.notion.com/v1/users/me", expect: "refused" },
  {
    connector: "oura",
    name: "v2 personal_info",
    url: "https://api.ouraring.com/v2/usercollection/personal_info",
    expect: "refused",
  },
  { connector: "ynab", name: "v1/budgets", url: "https://api.ynab.com/v1/budgets", expect: "refused" },
  { connector: "slack", name: "auth.test", url: "https://slack.com/api/auth.test", expect: "served" },
  { connector: "spotify", name: "v1/me", url: "https://api.spotify.com/v1/me", expect: "refused" },
  { connector: "strava", name: "v3/athlete", url: "https://www.strava.com/api/v3/athlete", expect: "refused" },
  {
    connector: "reddit",
    name: "api/v1/me (RETIRED SURFACE — see note)",
    url: "https://oauth.reddit.com/api/v1/me",
    expect: "refused",
    note:
      "connectors/reddit/index.ts:96 no longer requests this path — the connector now uses a browser session " +
      "against old.reddit.com/user/{u}/*.json (index.ts:10-12) since Reddit retired the OAuth script-app grant in " +
      "2024. old.reddit.com itself cannot be probed here: it 403s every non-browser client uniformly regardless of " +
      "path validity (verified live), so it can't distinguish a wrong path from Reddit's own anti-bot block. Left " +
      "in place as a still-real, still-informative Reddit API surface rather than removed, but it is NOT what the " +
      "connector calls today — do not read a PATH_OK here as reachability proof for reddit's actual request.",
  },
  {
    connector: "jellyfin",
    name: "Users/Me (root-served, NOT /api)",
    url: (base) => `${base.replace(/\/+$/, "")}/Users/Me`,
    baseEnv: "JELLYFIN_BASE_URL",
    expect: "refused",
  },
  {
    connector: "jellyfin",
    name: "System/Info/Public",
    url: (base) => `${base.replace(/\/+$/, "")}/System/Info/Public`,
    baseEnv: "JELLYFIN_BASE_URL",
    expect: "served",
  },
  {
    connector: "google_calendar",
    name: "calendar/v3/users/me/calendarList",
    url: "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    expect: "refused",
    // connectors/google_calendar/api.ts:22,205
  },
  {
    connector: "google_contacts",
    name: "people/v1/people/me/connections",
    url: "https://people.googleapis.com/v1/people/me/connections",
    expect: "refused",
    // connectors/google_contacts/api.ts:23,244
  },
  {
    connector: "google_maps_data_portability",
    name: "dataportability/v1/accessType:check",
    url: "https://dataportability.googleapis.com/v1/accessType:check",
    method: "POST",
    expect: "refused",
    // connectors/google_maps_data_portability/api.ts:4,120-121
  },
  {
    connector: "apple_contacts",
    name: "iCloud CardDAV .well-known discovery",
    url: "https://contacts.icloud.com/.well-known/carddav",
    method: "PROPFIND",
    expect: "refused",
    // connectors/apple_contacts/discovery.ts:19-27,242 (RFC 6764 §5 bootstrap
    // discovery); the connector does not hardcode this host — it discovers an
    // owner-entered origin — but iCloud is the overwhelmingly common real-world
    // origin, so this is a representative, not exhaustive, probe.
  },
];

async function probe(url, method) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: method ?? "GET", redirect: "manual", signal: controller.signal });
    return { status: res.status };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function classify(target, status) {
  if (status === 0) {
    return { verdict: "UNREACHABLE", note: "network error or timeout — inconclusive, not a failure" };
  }
  if (status === 404) {
    return { verdict: "WRONG_PATH", note: "404 — this path does not exist. THE JELLYFIN CLASS." };
  }
  if (status === 401 || status === 403) {
    return target.expect === "refused"
      ? { verdict: "PATH_OK", note: `${status} — exists, requires auth (expected)` }
      : { verdict: "INFO", note: `${status} — expected a public response; endpoint may have changed` };
  }
  if (status >= 200 && status < 300) {
    return target.expect === "served"
      ? { verdict: "PATH_OK", note: `${status} — public endpoint served (expected)` }
      : { verdict: "INFO", note: `${status} — served without auth; verify this is intended` };
  }
  if (status >= 500) {
    return { verdict: "INFO", note: `${status} — provider-side error, inconclusive` };
  }
  return { verdict: "INFO", note: `${status}` };
}

const results = [];
for (const target of TARGETS) {
  let url = target.url;
  if (typeof url === "function") {
    const base = target.baseEnv ? process.env[target.baseEnv] : null;
    if (!base) {
      results.push({
        connector: target.connector,
        name: target.name,
        note: `self-hosted — set ${target.baseEnv} to probe`,
        verdict: "NEEDS_HOST",
      });
      continue;
    }
    url = url(base);
  }
  // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose — parallel probes against many providers read as scanning.
  const { status } = await probe(url, target.method);
  const { note, verdict } = classify(target, status);
  results.push({ connector: target.connector, name: target.name, note, status, verdict, url });
}

const wrong = results.filter((r) => r.verdict === "WRONG_PATH");

if (JSON_OUT) {
  console.log(JSON.stringify({ results, wrongPaths: wrong.length }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.verdict.padEnd(12)} ${r.connector.padEnd(10)} ${r.name.padEnd(34)} ${r.note}`);
  }
  const counts = results.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {});
  console.log(
    `\n${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")}`
  );
  if (wrong.length > 0) {
    console.log("\nWRONG_PATH means the connector requests a URL the provider does not serve.");
  }
}

process.exit(STRICT && wrong.length > 0 ? 1 : 0);
