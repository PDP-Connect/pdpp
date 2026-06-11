/**
 * Guard tests for the landing field-projection set-piece (UI design-direction
 * decision 5: "the one motion set-piece").
 *
 * The accepted shape:
 *   - The field-projection hero is the SINGLE expressive moment. It animates
 *     the grant filtering data fields (allowed fields flow through, others fade
 *     and redact) on scroll-into-view, once.
 *   - Restrained vocabulary: ease-out, 150–250ms, NO spring/bounce.
 *   - prefers-reduced-motion users get the STATIC FINAL STATE — the projected
 *     result, rendered with zero-duration transitions (an instant cut, no
 *     choreography).
 *   - The colour temperature flows through the token system: the grant filter
 *     reads as a protocol fact (--authorship-protocol-*), not a literal.
 *
 * These are source-text guards (the repo's established test shape — see
 * theme-runtime.test.ts and reference-page-no-hardcoded-host.test.mjs); the
 * site has no jsdom/render harness.
 *
 * Run: node --test apps/site/scripts/reference-app-motion-reduced.test.mjs
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const COMPONENT_PATH = new URL("../src/components/reference-app.tsx", import.meta.url);
const BRAND_BASE_PATH = new URL("../../../packages/pdpp-brand/base.css", import.meta.url);

async function readComponent() {
  return readFile(fileURLToPath(COMPONENT_PATH), "utf8");
}

test("field-projection set-piece detects prefers-reduced-motion", async () => {
  const src = await readComponent();
  // The FieldProjection component must read the user's motion preference.
  const projectionStart = src.indexOf("function FieldProjection");
  assert.ok(projectionStart !== -1, "FieldProjection component must exist");
  const projectionSrc = src.slice(projectionStart, projectionStart + 4000);
  assert.match(
    projectionSrc,
    /matchMedia\(\s*["']\(prefers-reduced-motion: reduce\)["']\s*\)/,
    "FieldProjection must query (prefers-reduced-motion: reduce)"
  );
});

test("reduced motion renders the static final state, no choreography", async () => {
  const src = await readComponent();
  const projectionStart = src.indexOf("function FieldProjection");
  const projectionSrc = src.slice(projectionStart, projectionStart + 4000);

  // When reduced, the animation skips show→filter→result and lands directly on
  // the projected "result" phase.
  assert.match(
    projectionSrc,
    /prefersReduced\.current[\s\S]*?setPhase\(\s*["']result["']\s*\)/,
    "reduced-motion path must jump straight to the final projected (result) state"
  );

  // Reduced motion must zero the transition duration so any property change is
  // an instant cut rather than a tween.
  assert.match(
    projectionSrc,
    /reduced\s*\?\s*0\s*:\s*PROJECTION_DURATION_MS/,
    "reduced-motion duration must collapse to 0ms (static final state)"
  );
  assert.match(
    projectionSrc,
    /reduced\s*\?\s*0\s*:\s*PROJECTION_STAGGER_MS/,
    "reduced-motion stagger must collapse to 0ms"
  );
});

test("set-piece timing stays within the restrained 150–250ms ease-out vocabulary", async () => {
  const src = await readComponent();

  // The set-piece duration constant must sit inside the decision-5 envelope.
  const durMatch = src.match(/const PROJECTION_DURATION_MS\s*=\s*(\d+)/);
  assert.ok(durMatch, "PROJECTION_DURATION_MS constant must be declared");
  const dur = Number(durMatch[1]);
  assert.ok(dur >= 150 && dur <= 250, `set-piece duration ${dur}ms must be within 150–250ms`);

  // Ease-out, no spring/bounce: the set-piece uses the ease-enter (ease-out)
  // token, never a spring curve.
  assert.match(
    src,
    /const PROJECTION_EASE\s*=\s*["']var\(--ease-enter\)["']/,
    "set-piece must use the ease-out (--ease-enter) token"
  );
  const projectionStart = src.indexOf("function FieldProjection");
  const projectionEnd = src.indexOf("function IncrementalSync");
  const projectionSrc = src.slice(projectionStart, projectionEnd);
  assert.doesNotMatch(
    projectionSrc,
    /ease-spring|cubic-bezier\([^)]*1\.\d/,
    "set-piece must not use a spring/bounce curve"
  );
});

test("grant filter reads as a protocol fact via authorship tokens, no literals", async () => {
  const src = await readComponent();
  const projectionStart = src.indexOf("function FieldProjection");
  const projectionEnd = src.indexOf("function IncrementalSync");
  const projectionSrc = src.slice(projectionStart, projectionEnd);

  assert.match(
    projectionSrc,
    /var\(--authorship-protocol\)/,
    "the grant filter line must use the protocol authorship token"
  );
  // No raw oklch/rgba/hex colour literals anywhere in the set-piece.
  assert.doesNotMatch(projectionSrc, /oklch\(|rgba?\(|#[0-9a-fA-F]{3,8}\b/, "set-piece must not hardcode colour literals");
});

test("brand base.css zeroes durations under prefers-reduced-motion", async () => {
  const src = await readFile(fileURLToPath(BRAND_BASE_PATH), "utf8");
  // The reduced-motion media query must collapse --duration-base (which the
  // --motion-projection token and the set-piece both build on).
  assert.match(
    src,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?--duration-base:\s*0\.01ms/,
    "base.css must zero --duration-base under reduced motion"
  );
});
