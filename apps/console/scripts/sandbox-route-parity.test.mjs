/**
 * Rendered-output parity probe for the sandbox routes.
 *
 * Source-level guards live in `src/app/sandbox/_demo/mock-owner-shell.test.ts`
 * — they grep page sources for `/dashboard` URL literals. Those tests miss
 * leaks that come in through *shared* components rendered by sandbox pages
 * (the live overview hero, shell, etc.), because the offending literal is
 * not in the sandbox tree.
 *
 * This probe inspects the actual rendered HTML emitted by `next build` and
 * asserts that no sandbox page contains a real-dashboard `href` attribute.
 * It is the "as the user sees it" guard for the sandbox/dashboard split.
 *
 * How to run:
 *
 *   cd apps/web
 *   pnpm build      # populates .next/server/app/sandbox/**.html
 *   node --test --no-warnings scripts/sandbox-route-parity.test.mjs
 *
 * If `.next/server/app/sandbox.html` is missing, the test fails with a
 * "build first" message rather than silently skipping. This is intentional:
 * a probe that hides itself when the artifact is absent gives a false sense
 * of safety in CI.
 *
 * The previously-found leak this probe catches: `OverviewHero` rendered the
 * literal `href="/dashboard/records"` regardless of mode, so the sandbox
 * overview page emitted dashboard links into the visitor's HTML. Source-level
 * tests did not catch it because the literal lives in
 * `src/app/dashboard/components/overview-hero.tsx`, which the sandbox-source
 * scan does not walk.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_WEB_ROOT = join(HERE, "..");
const NEXT_APP_DIR = join(APP_WEB_ROOT, ".next", "server", "app");

/**
 * Sandbox routes covered by this probe. Each entry maps a URL-shaped key
 * (used in failure messages) to the prerendered HTML file `next build`
 * emits for that route. Dynamic routes (e.g. `/sandbox/search`) do not
 * appear here because Next does not pre-render them; covering those would
 * require booting `next start` and is left to a follow-up slice.
 *
 * Coverage rationale: the four routes the worker task names plus the
 * launcher and a parity sample (`schedules` was not previously reported
 * as a regressor but follows the same shared-shell path, so it is a
 * cheap extra).
 */
const SANDBOX_ROUTES = /** @type {const} */ ([
  ["/sandbox", "sandbox.html"],
  ["/sandbox/overview", "sandbox/overview.html"],
  ["/sandbox/records", "sandbox/records.html"],
  ["/sandbox/grants", "sandbox/grants.html"],
  ["/sandbox/runs", "sandbox/runs.html"],
  ["/sandbox/traces", "sandbox/traces.html"],
  ["/sandbox/schedules", "sandbox/schedules.html"],
  ["/sandbox/walkthrough", "sandbox/walkthrough.html"],
  ["/sandbox/api-examples", "sandbox/api-examples.html"],
]);

/**
 * Match `href="/dashboard"`, `href="/dashboard/anything"`, and the
 * escaped-quoted JSON form embedded in Next's RSC Flight payload
 * (e.g. `\"href\":\"/dashboard/records\"`).
 *
 * Shape: an `href` token, followed by `=` (HTML attribute) or `:`
 * (JSON key), followed by any mix of quotes and backslashes (so both
 * `="` and `\":\"` parse), followed by `/dashboard` and a path-or-quote
 * boundary. The trailing lookahead `(?=[/"'\\])` rejects
 * `/dashboard-light` while accepting clean boundaries.
 *
 * Why match the RSC payload too: the visitor's first paint is the static
 * HTML, but the same payload is what hydrates client navigation. A
 * `/dashboard` href in either branch sends the mock-owner visitor out of
 * the sandbox.
 */
const DASHBOARD_HREF_RE = /href[\\"']*\s*[=:]\s*[\\"']+\s*\/dashboard(?=[/"'\\])/g;

async function readBuiltHtml(rel) {
  const full = join(NEXT_APP_DIR, rel);
  try {
    return await readFile(full, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      assert.fail(
        `Missing prerendered HTML at ${rel}. Run \`pnpm --dir apps/web build\` before this probe.`
      );
    }
    throw err;
  }
}

/**
 * Strip `next build`'s embedded JSON-string copies of the route source map
 * (script tags whose body is a `self.__next_f.push(...)` call). Those
 * payloads contain prose-y references to `/dashboard/...` from page
 * comments and metadata that are NOT links the user can click. Keeping
 * them in scope produces noise; removing them keeps the probe focused on
 * actual `href` attributes and RSC payload links.
 *
 * The RSC payload still contains real `href` references — those use the
 * `\"href\":\"/dashboard/...\"` shape, which the regex catches outside
 * the prose blocks because the Flight payload is also embedded in
 * `self.__next_f.push` calls. To keep that signal, we leave Flight pushes
 * intact; we only strip nothing here. (Documented for the next reader so
 * nobody adds a strip step that drops the RSC payload.)
 */
function scanForDashboardHrefs(html) {
  return html.match(DASHBOARD_HREF_RE) ?? [];
}

for (const [routePath, rel] of SANDBOX_ROUTES) {
  test(`rendered ${routePath} does not contain real-dashboard href links`, async () => {
    const html = await readBuiltHtml(rel);
    const offenders = scanForDashboardHrefs(html);
    assert.deepEqual(
      offenders,
      [],
      `${routePath} (${rel}) leaked ${offenders.length} dashboard href(s) into the rendered output:\n  ` +
        `${[...new Set(offenders)].slice(0, 10).join("\n  ")}\n` +
        "Sandbox pages must link only inside /sandbox; dashboard literals send the mock-owner visitor out of the sandbox."
    );
  });
}

// Sabotage probe: confirms the assertion would actually catch an injected
// dashboard link. We synthesize the leak in-memory (no real file is touched)
// and assert that the matcher reports it. This is the meta-test that proves
// the regex is not silently null-matching, and that a future refactor of
// the matcher will fail loudly if it loses sensitivity.
test("scanner detects an injected /dashboard href (sabotage probe)", () => {
  const sabotaged = `<a href="/sandbox/runs">runs</a><a href="/dashboard/records">leak</a>`;
  const offenders = scanForDashboardHrefs(sabotaged);
  assert.equal(offenders.length, 1, `expected one match, got ${offenders.length}: ${offenders.join(",")}`);
  // RSC-payload shape: escaped-quote variant, must also be caught.
  const sabotagedRsc = String.raw`{"href":\"/dashboard/grants\","children":"x"}`;
  assert.equal(scanForDashboardHrefs(sabotagedRsc).length, 1, "RSC escaped-quote variant must match");
  // Negative case: a prose mention of /dashboard inside text content must
  // NOT match — only attribute-shaped occurrences should.
  assert.equal(scanForDashboardHrefs("<p>visit the /dashboard surface</p>").length, 0);
  // Negative case: module-spec style alias paths must NOT match.
  assert.equal(scanForDashboardHrefs(`from "@/app/dashboard/components/shell"`).length, 0);
});
