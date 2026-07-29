// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { applyCatchClauseNarrowing, planCatchClauseNarrowing } from "./catch-clause-narrowing.ts";
import { createMagicString } from "./magic-string.ts";

test("classifies a catch clause with no member access as no-member-access", () => {
  const src = "try { x(); } catch (err) { log(err); }\n";
  const plan = planCatchClauseNarrowing(src, "f.ts");
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.reason, "no-member-access");
});

test("classifies a catch clause with only .message access as eligible", () => {
  const src = "try { x(); } catch (err) { log(err.message); }\n";
  const plan = planCatchClauseNarrowing(src, "f.ts");
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.reason, "eligible");
  assert.equal(plan[0]?.replacement, "(err instanceof Error ? err.message : String(err))");
});

test("classifies a catch clause with a non-.message property access as non-message-property (refuses to guess)", () => {
  const src = "try { x(); } catch (err) { log(err.code); }\n";
  const plan = planCatchClauseNarrowing(src, "f.ts");
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.reason, "non-message-property");
});

test("classifies a mixed .message + other property access as non-message-property (refuses the WHOLE clause, not partial)", () => {
  const src = "try { x(); } catch (err) { log(err.message, err.code); }\n";
  const plan = planCatchClauseNarrowing(src, "f.ts");
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.reason, "non-message-property");
});

test("classifies a destructured catch parameter as unsupported-param-shape", () => {
  const src = "try { x(); } catch ({ message }) { log(message); }\n";
  const plan = planCatchClauseNarrowing(src, "f.ts");
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.reason, "unsupported-param-shape");
});

test("a catch clause with no parameter produces no plan entry", () => {
  const src = "try { x(); } catch { log('failed'); }\n";
  const plan = planCatchClauseNarrowing(src, "f.ts");
  assert.equal(plan.length, 0);
});

test("does NOT double-wrap an already-guarded `err instanceof Error ? err.message : String(err)` ternary", () => {
  const src = "try { x(); } catch (err) { log(err instanceof Error ? err.message : String(err)); }\n";
  const plan = planCatchClauseNarrowing(src, "f.ts");
  assert.equal(plan.length, 1);
  assert.equal(
    plan[0]?.reason,
    "no-member-access",
    "the .message access inside the guard's consequent branch must not be counted as needing narrowing"
  );
});

test("does NOT double-wrap an already-guarded if-statement form", () => {
  const src =
    "try { x(); } catch (err) { if (err instanceof Error) { log(err.message); } else { log(String(err)); } }\n";
  const plan = planCatchClauseNarrowing(src, "f.ts");
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.reason, "no-member-access");
});

test("applyCatchClauseNarrowing rewrites every eligible .message access and leaves ineligible ones untouched", () => {
  const src = "try { x(); } catch (err) { log(err.message); }\n";
  const plan = planCatchClauseNarrowing(src, "f.ts");
  const rewritten = applyCatchClauseNarrowing(src, plan, createMagicString);
  assert.equal(rewritten, "try { x(); } catch (err) { log((err instanceof Error ? err.message : String(err))); }\n");
});

test("applyCatchClauseNarrowing is a no-op when there is nothing eligible", () => {
  const src = "try { x(); } catch (err) { log(err.code); }\n";
  const plan = planCatchClauseNarrowing(src, "f.ts");
  const rewritten = applyCatchClauseNarrowing(src, plan, createMagicString);
  assert.equal(rewritten, src);
});

test("applyCatchClauseNarrowing rewrites multiple .message sites across multiple catch clauses in one pass", () => {
  const src = [
    "try { a(); } catch (err) { log(err.message); }",
    "try { b(); } catch (err2) { log(err2.message); }",
    "",
  ].join("\n");
  const plan = planCatchClauseNarrowing(src, "f.ts");
  const rewritten = applyCatchClauseNarrowing(src, plan, createMagicString);
  assert.equal(
    rewritten,
    [
      "try { a(); } catch (err) { log((err instanceof Error ? err.message : String(err))); }",
      "try { b(); } catch (err2) { log((err2 instanceof Error ? err2.message : String(err2))); }",
      "",
    ].join("\n")
  );
});

test("the produced rewrite parses as valid TypeScript", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: this is a literal fixture SOURCE-CODE-AS-STRING sample containing a template literal, not accidental JS interpolation.
  const src = "try { x(); } catch (err) { log(`failed: ${err.message}`); }\n";
  const plan = planCatchClauseNarrowing(src, "f.ts");
  const rewritten = applyCatchClauseNarrowing(src, plan, createMagicString);
  // re-parsing via planCatchClauseNarrowing itself proves the rewritten
  // text is syntactically valid (it would throw on malformed input).
  assert.doesNotThrow(() => planCatchClauseNarrowing(rewritten, "f.ts"));
});
