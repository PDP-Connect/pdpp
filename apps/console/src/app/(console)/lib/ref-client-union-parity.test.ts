// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Both-directions parity between every `Ref*` closed union in `ref-client.ts`
 * and the reference server union it mirrors.
 *
 * THE DRIFT THIS PREVENTS. The console cannot import server runtime code
 * (`ref-client.ts` pulls in `server-only` transitively — see
 * `ref-client-pagination.test.ts`'s header), so every closed union the server
 * emits over the wire is RE-DECLARED BY HAND here. That hand-typed mirror is a
 * second, unversioned copy of the producer's contract, and unlike a cast there
 * is no compiler check being switched off — the check never existed. Both
 * sides are valid TypeScript in isolation and no expression anywhere relates
 * them, so a producer can gain, lose, or rename a member and every test in the
 * repo stays green.
 *
 * That is not theoretical, and a one-off guard is demonstrably not enough:
 *   - `9496dbe57` widened `RefVerdictPill.label` after the server's "Archived"
 *     and "Setup never completed" pills were unrepresentable in the console,
 *     and added `ref-client-verdict-label-parity.test.ts` to stop it
 *     recurring. It recurred the NEXT DAY: `fe890342a` added "Some records
 *     stuck" to the producer and did not touch the mirror. The guard could not
 *     see it, because the guard's notion of "what the server emits" was itself
 *     a hand-typed list.
 *   - `RefActionRemediationCause` drifted from its producer since the initial
 *     contribution and had no test at all, so `transient_upload_failure` and
 *     `stale_heartbeat` — both live producer outputs — fell through
 *     `outboxCauseExplanation`'s `default` arm in
 *     `sources/[connector]/connection-diagnostics.tsx`. The owner was told to
 *     run recovery commands on another host for a condition the producer had
 *     explicitly classified as transient. Nothing crashed; the wrong output
 *     was well-formed, which is what made it durable.
 *
 * WHY THIS TEST READS SOURCE TEXT. Same constraint as its two sibling
 * source-scanning suites in this directory (`ref-client-pagination.test.ts`,
 * `rs-client-route-agreement.test.ts`): neither side can be imported into a
 * plain `node:test` process, so the contract is pinned at the source-text
 * level by parsing both declarations and comparing the member SETS.
 *
 * BOTH DIRECTIONS, AND WHY. A producer member missing from the console is a
 * value the console cannot narrow or switch on. A console member the producer
 * never emits is dead code that invites a `case` arm for an impossible state
 * and misleads the next reader about what the server can do. The superseded
 * `ref-client-verdict-label-parity.test.ts` checked only one direction (a
 * one-sided `includes`), which is a second reason it could not hold the line.
 *
 * SUPERSEDES `ref-client-verdict-label-parity.test.ts`, deleted in the same
 * commit. That file was green while the union it existed to guard was drifted,
 * because its expectation was a hand-typed list of 11 labels — so it asserted
 * only that the mirror agreed with a copy of itself. Its union is covered here
 * as the `RefVerdictPill.label` pair, read live from `VerdictLabel`.
 *
 * THE FALSIFIER. Add a dummy member to any producer union below and this test
 * must go red WITHOUT ANY EDIT TO THIS FILE. That property is what
 * distinguishes this from the guards it replaces, and `PAIR_LOCATORS` is
 * deliberately structured so that satisfying it requires touching the mirror,
 * never the expectation.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REF_CLIENT_FILE = `${HERE}ref-client.ts`;
const RI_ROOT = fileURLToPath(new URL("../../../../../../reference-implementation/", import.meta.url));

const REF_UNION_DECLARATION_RE = /^export type (Ref[A-Za-z0-9]*)\s*=([\s\S]*?);/gm;
const HAS_STRING_LITERAL_RE = /"/;
const STRING_LITERAL_RE = /"[^"]*"/g;
const UNION_PUNCTUATION_RE = /[|\s]/g;

/**
 * How a producer union is spelled on the server. The server does not declare
 * these uniformly, so the extractor has to handle four real shapes rather than
 * assume one.
 */
type ProducerForm =
  /** `export type Name = "a" | "b";` — 20 of 26 pairs. */
  | { readonly kind: "type-alias"; readonly file: string; readonly name: string }
  /** `type Name = "a" | "b";` — unexported local alias. */
  | { readonly kind: "local-type-alias"; readonly file: string; readonly name: string }
  /** `readonly field: "a" | "b";` — inline union on an interface field, no alias anywhere. */
  | { readonly kind: "interface-field"; readonly file: string; readonly interface: string; readonly field: string }
  /** `export const NAME = Object.freeze([...]);` — const array the type is derived from. */
  | { readonly kind: "const-array"; readonly file: string; readonly name: string };

/**
 * How a console mirror is spelled. Two real shapes.
 */
type MirrorForm =
  /** `export type RefName = "a" | "b";` — 26 of 27 mirrors. */
  | { readonly kind: "type-alias"; readonly name: string }
  /** `label: "a" | "b";` — inline union on an exported interface field. */
  | { readonly kind: "interface-field"; readonly interface: string; readonly field: string };

interface UnionPair {
  /**
   * Console members the producer deliberately does not emit. MUST be empty
   * unless there is a justified, individually-commented reason directly above
   * the entry. An exemption is a claim that a value is genuinely client-only;
   * it is not a place to park a drift you have not diagnosed.
   */
  readonly consoleOnly?: readonly string[];
  readonly mirror: MirrorForm;
  readonly producer: ProducerForm;
}

/**
 * ============================ THE HAND-WRITTEN RESIDUE ======================
 *
 * READ THIS BEFORE ADDING A UNION. Everything below this line is the part of
 * the derivation that is NOT mechanical, and it is the part most likely to rot.
 *
 * WHAT IS MECHANICAL. The set of unions to check is NOT hand-listed: the
 * "every Ref* union is covered" test at the bottom of this file enumerates the
 * mirrors straight out of `ref-client.ts` and fails if any one of them is
 * absent from this table. So a NEW `Ref*` union cannot be added to the console
 * without this file failing — you cannot silently skip one, which is the exact
 * failure mode that makes hand-listed guards worthless.
 *
 * WHAT IS NOT MECHANICAL, AND WHY. The producer LOCATION cannot be derived. I
 * tried `Ref` + identical name and it resolves only 20 of 26 unions. The other
 * six each fail for a different reason, and no naming rule covers them:
 *   - `RefTerminalSetupDisposition` -> `SetupTerminalDisposition`: the words are
 *     TRANSPOSED, not prefixed.
 *   - `RefNotificationPosture`, `RefRecordVersionRisk`: the server has NO named
 *     type at all, only an inline union on an interface field.
 *   - `RefRecordVersionDisposition`, `RefRecordVersionRemediation`: the server
 *     type is derived from a frozen const array, and because that array lacks
 *     `as const` the derived type widens to `string` — so the literal members
 *     exist ONLY in the array, never in a type.
 *   - `RefCountState`: the five members are re-declared in ~10 places across
 *     two files; the exported `CountState` is the only named one.
 * A heuristic that guessed these would either miss them (silently reintroducing
 * the class) or bind the wrong producer (asserting a false contract). So the
 * locator is written by hand and the COVERAGE CHECK is what keeps it honest:
 * the table must be total over the mirrors, and every member comparison is
 * still read live from producer source. Nothing here restates a member list.
 * ===========================================================================
 */
const PAIR_LOCATORS: readonly UnionPair[] = [
  // --- Same-name producers (mechanical `Ref` + identical name) ---------------
  {
    mirror: { kind: "type-alias", name: "RefRunAutomationMode" },
    producer: { kind: "type-alias", file: "runtime/run-automation-policy.ts", name: "RunAutomationMode" },
  },
  {
    mirror: { kind: "type-alias", name: "RefSourceWorkGroup" },
    producer: { kind: "type-alias", file: "runtime/owner-state.ts", name: "SourceWorkGroup" },
  },
  {
    mirror: { kind: "type-alias", name: "RefFleetHealthState" },
    producer: { kind: "type-alias", file: "server/fleet-health.ts", name: "FleetHealthState" },
  },
  {
    mirror: { kind: "type-alias", name: "RefOwnerStateResolver" },
    producer: { kind: "type-alias", file: "runtime/owner-state.ts", name: "OwnerStateResolver" },
  },
  {
    mirror: { kind: "type-alias", name: "RefOwnerOfState" },
    producer: { kind: "type-alias", file: "runtime/owner-state.ts", name: "OwnerOfState" },
  },
  {
    mirror: { kind: "type-alias", name: "RefOwnerStatePosture" },
    producer: { kind: "type-alias", file: "runtime/owner-state.ts", name: "OwnerStatePosture" },
  },
  {
    mirror: { kind: "type-alias", name: "RefVerdictTone" },
    producer: { kind: "type-alias", file: "runtime/rendered-verdict.ts", name: "VerdictTone" },
  },
  {
    mirror: { kind: "type-alias", name: "RefRenderedChannel" },
    producer: { kind: "type-alias", file: "runtime/rendered-verdict.ts", name: "RenderedChannel" },
  },
  {
    mirror: { kind: "type-alias", name: "RefRequiredActionKind" },
    producer: { kind: "type-alias", file: "runtime/rendered-verdict.ts", name: "RequiredActionKind" },
  },
  {
    mirror: { kind: "type-alias", name: "RefActionAudience" },
    producer: { kind: "type-alias", file: "runtime/rendered-verdict.ts", name: "ActionAudience" },
  },
  {
    mirror: { kind: "type-alias", name: "RefActionUrgency" },
    producer: { kind: "type-alias", file: "runtime/rendered-verdict.ts", name: "ActionUrgency" },
  },
  {
    mirror: { kind: "type-alias", name: "RefActionRemediationCause" },
    producer: { kind: "type-alias", file: "runtime/rendered-verdict.ts", name: "ActionRemediationCause" },
  },
  {
    mirror: { kind: "type-alias", name: "RefActionRemediationCommandKind" },
    producer: { kind: "type-alias", file: "runtime/rendered-verdict.ts", name: "ActionRemediationCommandKind" },
  },
  {
    mirror: { kind: "type-alias", name: "RefOwnerActionSurfaceKind" },
    producer: { kind: "type-alias", file: "runtime/connection-health.ts", name: "OwnerActionSurfaceKind" },
  },
  {
    mirror: { kind: "type-alias", name: "RefAttentionAxis" },
    producer: { kind: "type-alias", file: "runtime/connection-health.ts", name: "AttentionAxis" },
  },
  {
    mirror: { kind: "type-alias", name: "RefCoverageAxis" },
    producer: { kind: "type-alias", file: "runtime/connection-health.ts", name: "CoverageAxis" },
  },
  {
    mirror: { kind: "type-alias", name: "RefFreshnessAxis" },
    producer: { kind: "type-alias", file: "runtime/connection-health.ts", name: "FreshnessAxis" },
  },
  {
    mirror: { kind: "type-alias", name: "RefForwardDisposition" },
    producer: { kind: "type-alias", file: "runtime/connection-health.ts", name: "ForwardDisposition" },
  },
  {
    mirror: { kind: "type-alias", name: "RefOutboxAxis" },
    producer: { kind: "type-alias", file: "runtime/connection-health.ts", name: "OutboxAxis" },
  },
  {
    mirror: { kind: "type-alias", name: "RefRemoteSurfaceAxis" },
    producer: { kind: "type-alias", file: "runtime/connection-health.ts", name: "RemoteSurfaceAxis" },
  },
  {
    mirror: { kind: "type-alias", name: "RefAcknowledgedLossCause" },
    producer: { kind: "type-alias", file: "runtime/acknowledged-loss.ts", name: "AcknowledgedLossCause" },
  },
  {
    mirror: { kind: "type-alias", name: "RefAcknowledgedLossScope" },
    producer: { kind: "type-alias", file: "runtime/acknowledged-loss.ts", name: "AcknowledgedLossScope" },
  },

  // --- Producers whose location is NOT derivable from the mirror name -------
  // Transposed words: `…TerminalSetup…` on the console, `SetupTerminal…` on the
  // server. Bound by the field, not the name: `terminal_setup_disposition` in
  // `ref-client.ts` mirrors the same field on `static-secret-setup-status.ts`.
  {
    mirror: { kind: "type-alias", name: "RefTerminalSetupDisposition" },
    producer: {
      kind: "type-alias",
      file: "runtime/static-secret-setup-status.ts",
      name: "SetupTerminalDisposition",
    },
  },
  // No named server type exists. The union lives inline on the projection
  // interface the wire payload is built from.
  {
    mirror: { kind: "type-alias", name: "RefNotificationPosture" },
    producer: {
      kind: "interface-field",
      file: "runtime/run-automation-policy.ts",
      interface: "RunAutomationPolicyProjection",
      field: "notification_posture",
    },
  },
  // No named server type exists; inline on `ChurnClassification`, which is the
  // classifier that emits the wire field `risk_level`.
  {
    mirror: { kind: "type-alias", name: "RefRecordVersionRisk" },
    producer: {
      kind: "interface-field",
      file: "server/record-version-stats.ts",
      interface: "ChurnClassification",
      field: "riskLevel",
    },
  },
  // The server's `VersionDisposition` is `(typeof VERSION_DISPOSITIONS)[number]`
  // over an `Object.freeze([...])` WITHOUT `as const`, so the alias widens to
  // `string` and the literals exist only in the array. Read the array.
  {
    mirror: { kind: "type-alias", name: "RefRecordVersionDisposition" },
    producer: { kind: "const-array", file: "server/version-disposition.ts", name: "VERSION_DISPOSITIONS" },
  },
  // Same shape as VERSION_DISPOSITIONS above.
  {
    mirror: { kind: "type-alias", name: "RefRecordVersionRemediation" },
    producer: { kind: "const-array", file: "server/version-disposition.ts", name: "VERSION_REMEDIATIONS" },
  },
  // The console types TWO wire fields with this union — `count_state` and
  // `total_records_state` — and the server declares the five members in ~10
  // places across two files. `CountState` is the only EXPORTED named one, so
  // it is the mirror target; the `ref-control.ts` duplicates are pinned by the
  // "server's own duplicate declarations agree" test below so that binding one
  // producer cannot hide a drift in the others.
  {
    mirror: { kind: "type-alias", name: "RefCountState" },
    producer: {
      kind: "type-alias",
      file: "server/connector-summary-evidence-engine.ts",
      name: "CountState",
    },
  },

  // --- Mirrors declared inline on a console interface -----------------------
  // Not a `Ref*` type alias, so the coverage check below cannot see it; listed
  // here because it is the union whose drift `9496dbe57`/`fe890342a` proved is
  // live. Supersedes `ref-client-verdict-label-parity.test.ts`, which checked
  // this same union in one direction against a hand-typed list.
  {
    mirror: { kind: "interface-field", interface: "RefVerdictPill", field: "label" },
    producer: { kind: "type-alias", file: "runtime/rendered-verdict.ts", name: "VerdictLabel" },
  },
];

/**
 * Removes comments from a whole source file BEFORE any declaration is matched.
 *
 * THIS STEP IS LOAD-BEARING AND ITS ORDER IS THE POINT. These unions are
 * densely commented and the prose quotes the very values it describes. The real
 * `VerdictLabel` docstring contains the text `10,001");` — a quoted string AND a
 * semicolon inside a comment. Matching the declaration first means:
 *   - the non-greedy `…;` boundary terminates on that comment's semicolon, so
 *     four real labels fall outside the captured body, and
 *   - the comment's quoted prose is harvested as if it were a member.
 * Both produce a FABRICATED drift report. A parity suite that cries wolf is
 * worse than none, because the next reader learns to edit the expectation.
 * Stripping comments up front removes the whole class.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Pulls the double-quoted string literals out of a declaration body, and
 * proves the body contains NOTHING ELSE. The purity check is what stops this
 * from silently degrading: if a union gains a non-literal member (a referenced
 * type, a template literal, `string`), the extractor must fail loudly rather
 * than compare a partial member list and report a false pass.
 */
/**
 * Asserts a regex capture group actually matched. Under
 * `noUncheckedIndexedAccess` these are `string | undefined`, and an undefined
 * capture means the extractor's pattern has gone stale against a reshaped
 * declaration — which must fail loudly, never coerce to an empty member list.
 */
function captured(value: string | undefined, what: string): string {
  assert.ok(value !== undefined, `${what}: the extractor matched but captured nothing — its pattern is stale.`);
  return value;
}

function literalsOf(body: string, what: string): string[] {
  const members = [...body.matchAll(/"([^"]*)"/g)].map((match) => captured(match[1], what));
  const residue = body.replace(/"[^"]*"/g, "").replace(/[|,\s]/g, "");
  assert.equal(
    residue,
    "",
    `${what} is not a pure string-literal union — leftover tokens: ${JSON.stringify(residue)}. ` +
      "This test compares member SETS and cannot reason about referenced types or template literals. " +
      "Either inline the members or teach this extractor the new shape; do NOT delete the pair."
  );
  assert.ok(members.length > 0, `${what} yielded no members — the extractor's pattern has gone stale.`);
  return members;
}

function extractTypeAlias(source: string, name: string, exported: boolean, what: string): string[] {
  const prefix = exported ? "export type" : "(?<!export )type";
  const match = source.match(new RegExp(`^${prefix} ${name}\\s*=([\\s\\S]*?);`, "m"));
  assert.ok(match, `${what}: could not find \`type ${name} = …;\` — it was renamed, moved, or deleted.`);
  return literalsOf(captured(match[1], what), what);
}

function extractInterfaceField(source: string, iface: string, field: string, what: string): string[] {
  const ifaceMatch = source.match(new RegExp(`interface ${iface} \\{[\\s\\S]*?\\n\\}`));
  assert.ok(ifaceMatch, `${what}: could not find \`interface ${iface}\`.`);
  const fieldMatch = ifaceMatch[0].match(new RegExp(`(?:readonly )?${field}\\??\\s*:([\\s\\S]*?);`));
  assert.ok(fieldMatch, `${what}: could not find field \`${field}\` on \`interface ${iface}\`.`);
  return literalsOf(captured(fieldMatch[1], what), what);
}

function extractConstArray(source: string, name: string, what: string): string[] {
  const match = source.match(new RegExp(`const ${name}\\s*=\\s*(?:Object\\.freeze\\()?\\[([\\s\\S]*?)\\]`));
  assert.ok(match, `${what}: could not find \`const ${name} = [ … ]\`.`);
  return literalsOf(captured(match[1], what), what);
}

const sourceCache = new Map<string, Promise<string>>();
function readCached(path: string): Promise<string> {
  const hit = sourceCache.get(path);
  if (hit) {
    return hit;
  }
  // Comments are stripped once, here, so every extractor below matches against
  // code only — see `stripComments` for why this cannot be done later.
  const pending = readFile(path, "utf8").then(stripComments);
  sourceCache.set(path, pending);
  return pending;
}

async function producerMembers(form: ProducerForm): Promise<string[]> {
  const source = await readCached(`${RI_ROOT}${form.file}`);
  const where = `reference-implementation/${form.file}`;
  // biome-ignore lint/style/useDefaultSwitchClause: exhaustive over the ProducerForm discriminant on purpose — a `default` arm would silence the compiler error that is the whole point when a new producer shape is added.
  switch (form.kind) {
    case "type-alias":
      return extractTypeAlias(source, form.name, true, `producer ${form.name} (${where})`);
    case "local-type-alias":
      return extractTypeAlias(source, form.name, false, `producer ${form.name} (${where})`);
    case "interface-field":
      return extractInterfaceField(
        source,
        form.interface,
        form.field,
        `producer ${form.interface}.${form.field} (${where})`
      );
    case "const-array":
      return extractConstArray(source, form.name, `producer ${form.name} (${where})`);
  }
}

async function mirrorMembers(form: MirrorForm): Promise<string[]> {
  const source = await readCached(REF_CLIENT_FILE);
  return form.kind === "type-alias"
    ? extractTypeAlias(source, form.name, true, `console ${form.name} (ref-client.ts)`)
    : extractInterfaceField(
        source,
        form.interface,
        form.field,
        `console ${form.interface}.${form.field} (ref-client.ts)`
      );
}

function mirrorLabel(form: MirrorForm): string {
  return form.kind === "type-alias" ? form.name : `${form.interface}.${form.field}`;
}

function producerLabel(form: ProducerForm): string {
  const name = form.kind === "interface-field" ? `${form.interface}.${form.field}` : form.name;
  return `${name} (reference-implementation/${form.file})`;
}

for (const pair of PAIR_LOCATORS) {
  const label = mirrorLabel(pair.mirror);

  test(`${label} mirrors every member of ${producerLabel(pair.producer)}, both directions`, async () => {
    const producer = new Set(await producerMembers(pair.producer));
    const mirror = new Set(await mirrorMembers(pair.mirror));
    const exempt = new Set(pair.consoleOnly ?? []);

    const missingFromConsole = [...producer].filter((member) => !mirror.has(member)).sort((a, b) => a.localeCompare(b));
    const notEmittedByServer = [...mirror]
      .filter((member) => !(producer.has(member) || exempt.has(member)))
      .sort((a, b) => a.localeCompare(b));

    assert.deepEqual(
      missingFromConsole,
      [],
      [
        `DRIFT — server -> console. \`${label}\` in ref-client.ts is MISSING ${missingFromConsole.length} member(s)`,
        `the server emits: ${missingFromConsole.map((member) => `"${member}"`).join(", ")}`,
        "",
        `  producer: ${producerLabel(pair.producer)}`,
        `  mirror:   apps/console/src/app/(console)/lib/ref-client.ts -> ${label}`,
        "",
        "The console cannot narrow or switch on a value it does not declare, so a consumer",
        "either fails to compile or silently takes a `default` arm written for something else.",
        "FIX: add the member(s) above to the console union, then add the matching `case` arm to",
        "every consumer that switches on it.",
      ].join("\n")
    );

    assert.deepEqual(
      notEmittedByServer,
      [],
      [
        `DRIFT — console -> server. \`${label}\` in ref-client.ts declares ${notEmittedByServer.length} member(s)`,
        `the server never emits: ${notEmittedByServer.map((member) => `"${member}"`).join(", ")}`,
        "",
        `  producer: ${producerLabel(pair.producer)}`,
        `  mirror:   apps/console/src/app/(console)/lib/ref-client.ts -> ${label}`,
        "",
        "A member the producer cannot emit is dead: it invites a `case` arm for an impossible",
        "state and misleads the next reader about what the server can do.",
        "FIX: delete the member(s) above. If a value is genuinely client-only, add it to that",
        "pair's `consoleOnly` list in this file WITH a comment justifying why the server never",
        "emits it — an unexplained exemption is the drift this suite exists to catch.",
      ].join("\n")
    );
  });
}

/**
 * THE ANTI-HAND-LIST GUARD. Without this, `PAIR_LOCATORS` would be exactly the
 * hand-typed allow-list this suite exists to abolish — a new `Ref*` union could
 * be added to `ref-client.ts` and simply never checked, which is how
 * `ref-client-verdict-label-parity.test.ts` and `CANDIDATE_REASON_CLASSES`
 * both failed. Enumerating the mirrors from source makes an omission loud.
 */
test("every closed Ref* union in ref-client.ts is covered by a parity pair", async () => {
  const source = await readCached(REF_CLIENT_FILE);
  const declared = [...source.matchAll(REF_UNION_DECLARATION_RE)]
    .map((match) => ({
      name: captured(match[1], "Ref* union enumeration"),
      body: captured(match[2], "Ref* union enumeration"),
    }))
    // Only closed string-literal unions are in scope. A `Ref*` alias built from
    // other types has a real compiler relationship and needs no text parity.
    .filter(
      ({ body }) =>
        HAS_STRING_LITERAL_RE.test(body) && body.replace(STRING_LITERAL_RE, "").replace(UNION_PUNCTUATION_RE, "") === ""
    )
    .map(({ name }) => name);

  assert.ok(declared.length >= 26, `Expected to find the Ref* unions in ref-client.ts, found ${declared.length}.`);

  const covered = new Set(
    PAIR_LOCATORS.filter((pair) => pair.mirror.kind === "type-alias").map((pair) =>
      pair.mirror.kind === "type-alias" ? pair.mirror.name : ""
    )
  );
  const uncovered = declared.filter((name) => !covered.has(name)).sort((a, b) => a.localeCompare(b));

  assert.deepEqual(
    uncovered,
    [],
    [
      `${uncovered.length} closed Ref* union(s) in ref-client.ts have NO parity pair: ${uncovered.join(", ")}`,
      "",
      "An unchecked mirror is a hand-typed copy of a server contract with nothing holding it",
      "honest — the exact defect this suite exists to prevent.",
      "FIX: add an entry to PAIR_LOCATORS naming the producer. If the union is genuinely",
      "console-local with no server producer, say so in a comment and point at the evidence.",
    ].join("\n")
  );
});

/**
 * THE EXTRACTOR'S OWN FALSIFIER. Every assertion above is only as trustworthy
 * as the parser underneath it, and while writing this suite the parser DID
 * report a fabricated drift: `VerdictLabel`'s docstring contains `10,001");`,
 * whose semicolon truncated the declaration and whose quoted prose was read as
 * a member. Four real labels were reported as console-only. This pins that
 * exact shape so the bug cannot return unnoticed.
 */
test("the extractor ignores quotes and semicolons that appear inside comments", () => {
  const source = stripComments(
    [
      "export type Sample =",
      '  // A stuck backlog always states its proportion ("1 of 10,001"); the',
      "  // label only sets the tone.",
      '  | "alpha"',
      '  /* Block comment with a stray "beta" and a semicolon; both inert. */',
      '  | "gamma";',
    ].join("\n")
  );

  assert.deepEqual(extractTypeAlias(source, "Sample", true, "extractor self-test"), ["alpha", "gamma"]);
});

/**
 * `RefCountState` mirrors ONE producer (`CountState`) but the server re-spells
 * those five members in `ref-control.ts` without importing it. Binding a single
 * producer would let those duplicates drift unseen, so pin them against the
 * bound producer directly — the console union is only as trustworthy as the
 * server's agreement with itself.
 */
test("the server's duplicate count-state declarations agree with the bound CountState producer", async () => {
  const engine = await readCached(`${RI_ROOT}server/connector-summary-evidence-engine.ts`);
  const bound = new Set(extractTypeAlias(engine, "CountState", true, "producer CountState"));

  const refControl = await readCached(`${RI_ROOT}server/ref-control.ts`);
  const duplicate = new Set(
    extractTypeAlias(refControl, "CountStateValue", false, "producer CountStateValue (server/ref-control.ts)")
  );

  assert.deepEqual(
    [...duplicate].sort((a, b) => a.localeCompare(b)),
    [...bound].sort((a, b) => a.localeCompare(b)),
    [
      "`CountStateValue` (server/ref-control.ts) has drifted from `CountState`",
      "(server/connector-summary-evidence-engine.ts). The console's `RefCountState` mirrors the",
      "latter, so this divergence means one of the two wire fields it types is now wrong.",
      "FIX: make ref-control.ts import `CountState` instead of re-declaring the members.",
    ].join("\n")
  );
});
