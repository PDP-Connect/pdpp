// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Checked-in registry of exactly 2 declarative fault operators over
 * `packages/polyfill-connectors/connectors/groupme/index.ts` (design.md
 * Decision #2/#6, tasks.md 2.1). Each operator's exact target preimage is
 * checked VERBATIM before applying — a mismatch aborts with
 * `PreimageMismatchError` rather than applying a stale or unintended
 * transform. This is the only place these two production ranges may be
 * changed by this program; every other file (tests, policy, runner,
 * manifest, lockfile, receipt validator) is immutable and digest-bound —
 * see `groupme-runner.ts`'s forbidden-path enforcement.
 *
 * Both preimages are quoted here as they existed at commit `a3c12dfd8`
 * (this branch's HEAD when this file was authored) in
 * `packages/polyfill-connectors/connectors/groupme/index.ts`.
 */

const GROUPME_INDEX_RELATIVE_PATH = "packages/polyfill-connectors/connectors/groupme/index.ts";

export class PreimageMismatchError extends Error {
  constructor(operatorId: string, targetFile: string) {
    super(
      `groupme-operators: operator ${operatorId}'s exact preimage does not match the live content of ${targetFile} — aborting rather than applying a stale or unintended transform`
    );
    this.name = "PreimageMismatchError";
  }
}

export interface GroupMeOperator {
  applyPostimage: (fileContent: string) => string;
  id: string;
  /** Exact verbatim string that MUST be present in `targetFile` before applying — checked by `applyOperator`. */
  preimage: string;
  riskDescription: string;
  targetFile: string;
  version: string;
}

// ── Operator 1: groupme-page-ceiling-v1 ────────────────────────────────────
//
// Preimage: `collectGroupMessagesForwardFromCursor`'s `usedCursors`
// declaration immediately followed by its unbounded `for (;;) { ... }` loop
// opener (index.ts lines ~1345-1349, as of a3c12dfd8). The identical
// `for (;;) {` loop-opener text also appears, byte-for-byte, at the start
// of the SEPARATE backward-walk function later in this same file — the
// `usedCursors` line is included specifically to make this preimage match
// ONLY the forward-cursor function's loop, never its backward sibling.
// Postimage: the identical loop wrapped with a bounded page counter that
// THROWS a distinguishable error once a fixed page cap is exceeded —
// reintroducing exactly the historical "page-count ceiling" fault the
// function's own doc comment (lines 1322-1324) says no longer exists
// anywhere in this loop. A thrown error (rather than a silent truncated
// return) is used because `runCollectionPass`'s existing catch converts any
// thrown error into an ordinary `failed: true` outcome — the same mechanism
// every other fault in this file already uses (NonProgressError,
// EmptyPageResponse, etc.) — which is exactly what makes
// `incremental-frontier.test.ts`'s real, pre-existing
// ">old-cap discriminator" test (which asserts `outcome.failed === false`
// and exact fetch/considered/cursor counts past 200 pages) fail once this
// operator is applied.
const PAGE_CEILING_PREIMAGE = `  const usedCursors = new Set<string>([startAfterId]);

  for (;;) {
    await progressWithSignals("Fetching group messages", {
      stream: "group_messages",`;
const PAGE_CEILING_POSTIMAGE = `  const usedCursors = new Set<string>([startAfterId]);

  let __mutationFalsificationPageCount = 0;
  const __MUTATION_FALSIFICATION_MAX_PAGES = 200;
  for (;;) {
    __mutationFalsificationPageCount += 1;
    if (__mutationFalsificationPageCount > __MUTATION_FALSIFICATION_MAX_PAGES) {
      throw new Error("groupme-page-ceiling-v1: reintroduced 200-page cap exceeded");
    }
    await progressWithSignals("Fetching group messages", {
      stream: "group_messages",`;

export const GROUPME_PAGE_CEILING_V1: GroupMeOperator = {
  id: "groupme-page-ceiling-v1",
  version: "1",
  targetFile: GROUPME_INDEX_RELATIVE_PATH,
  preimage: PAGE_CEILING_PREIMAGE,
  riskDescription:
    "Reintroduces a 200-page ceiling into collectGroupMessagesForwardFromCursor's forward walk, the exact historical fault class its own doc comment says no longer exists — a group with more than 200 pages of new messages would silently truncate instead of reaching the true natural end.",
  applyPostimage: (fileContent: string) => {
    if (!fileContent.includes(PAGE_CEILING_PREIMAGE)) {
      throw new PreimageMismatchError("groupme-page-ceiling-v1", GROUPME_INDEX_RELATIVE_PATH);
    }
    return fileContent.replace(PAGE_CEILING_PREIMAGE, PAGE_CEILING_POSTIMAGE);
  },
};

// ── Operator 2: groupme-nonprogress-weakening-v1 ───────────────────────────
//
// Preimage: `isAscendingByCreatedAt`'s complete function body (index.ts
// lines 1306-1315, as of a3c12dfd8) — the per-page ordering check that
// `collectGroupMessagesForwardFromCursor` (its sole call site, line ~1399)
// uses to decide whether to trust a forward page's cursor at all. Postimage:
// the function unconditionally returns `true`, i.e. it never detects a
// non-ascending page — a real weakened non-progress-detection fault. This
// is exactly what `incremental-frontier.test.ts`'s real, pre-existing test
// "repeated/nonprogressing cursor: a forward page violating documented
// ascending order fails as NonProgressError" (which asserts
// `outcome.failed === true` for an out-of-order page) requires to be true
// in order to pass — weakening the check to always return `true` makes
// that walk proceed instead of throwing `NonProgressError`, and the walk's
// eventual outcome no longer fails the way the test requires.
const NONPROGRESS_PREIMAGE = `function isAscendingByCreatedAt(messages: readonly GroupMeMessage[]): boolean {
  for (let i = 1; i < messages.length; i += 1) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (prev && curr && curr.created_at < prev.created_at) {
      return false;
    }
  }
  return true;
}`;
const NONPROGRESS_POSTIMAGE = `function isAscendingByCreatedAt(_messages: readonly GroupMeMessage[]): boolean {
  // groupme-nonprogress-weakening-v1: never detects a non-ascending page.
  return true;
}`;

export const GROUPME_NONPROGRESS_WEAKENING_V1: GroupMeOperator = {
  id: "groupme-nonprogress-weakening-v1",
  version: "1",
  targetFile: GROUPME_INDEX_RELATIVE_PATH,
  preimage: NONPROGRESS_PREIMAGE,
  riskDescription:
    "Weakens isAscendingByCreatedAt to always report a page as ascending, so a provider response that violates its own documented ordering contract is silently trusted instead of raising NonProgressError — risking a resumed walk built on an untrustworthy cursor.",
  applyPostimage: (fileContent: string) => {
    if (!fileContent.includes(NONPROGRESS_PREIMAGE)) {
      throw new PreimageMismatchError("groupme-nonprogress-weakening-v1", GROUPME_INDEX_RELATIVE_PATH);
    }
    return fileContent.replace(NONPROGRESS_PREIMAGE, NONPROGRESS_POSTIMAGE);
  },
};

export const GROUPME_OPERATORS: readonly GroupMeOperator[] = [GROUPME_PAGE_CEILING_V1, GROUPME_NONPROGRESS_WEAKENING_V1];

export function findGroupMeOperator(operatorId: string): GroupMeOperator {
  const operator = GROUPME_OPERATORS.find((entry) => entry.id === operatorId);
  if (!operator) {
    throw new Error(`groupme-operators: unregistered operator id: ${operatorId}`);
  }
  return operator;
}

/**
 * Applies `operator` to `fileContent`, checking the exact preimage first
 * (throwing `PreimageMismatchError` on any mismatch) and returning the
 * transformed content. Pure — does no I/O itself; the caller
 * (`groupme-runner.ts`) is responsible for reading/writing the target file
 * inside an isolated workspace, never the real source tree.
 */
export function applyOperator(operator: GroupMeOperator, fileContent: string): string {
  return operator.applyPostimage(fileContent);
}
