// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * COMPILE-TIME fixture for absent-only grant expiry.
 *
 * `expires_at` is absent-only: a grant with no expiry omits the field, and
 * `null` is not a valid value. A runtime test cannot pin that, because the
 * defect this guards against is a TYPE regression — someone widening the
 * contract back to `string | null`, or reintroducing a parallel internal grant
 * type that disagrees with it. Both are invisible to any assertion that only
 * inspects values.
 *
 * This file therefore contains no runtime assertions. It is type-level only,
 * and it is enforced by `pnpm typecheck` (`tsconfig.json` includes
 * `test/**\/*.ts`). If nullable expiry reappears in the public contract, the
 * assertions below stop compiling and the typecheck gate fails.
 *
 * The `.test-d.ts` suffix keeps it out of the `node --test` runner, which
 * matches `*.test.ts`: there is nothing here to execute.
 */

import type { ResolvedGrant } from "@pdpp/reference-contract/public/source";

// --- Type-level assertion helpers ----------------------------------------

/** Compiles only when `Actual` and `Expected` are the SAME type. */
type Exact<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends <T>() => T extends Expected ? 1 : 2 ? true : false;

/** Fails to compile unless its argument is exactly `true`. */
type AssertTrue<T extends true> = T;

// --- 1. The contract's expiry type is absent-only ------------------------

// `expires_at?: string` -- optional, and NEVER null. Reading the property type
// includes `undefined` because the member is optional; the point of the
// assertion is that `null` is absent from the union.
type ContractExpiry = ResolvedGrant["expires_at"];

export type _ExpiryIsOptionalStringOnly = AssertTrue<Exact<ContractExpiry, string | undefined>>;

// Stated in the negative as well, so the intent survives a careless edit to
// the assertion above: `null` must NOT be assignable to the expiry type.
export type _NullIsNotAnExpiry = AssertTrue<Exact<null extends ContractExpiry ? true : false, false>>;

// --- 2. The member is OPTIONAL, not merely nullable -----------------------

// Absent-only means a grant with no expiry omits the field entirely. If the
// member were required, `Omit`-ing it would change the type; because it is
// optional, a grant literal without `expires_at` satisfies the contract, which
// the value-level fixture immediately below proves.
export type _ExpiryMemberIsOptional = AssertTrue<
  Exact<Record<string, never> extends Pick<ResolvedGrant, "expires_at"> ? true : false, true>
>;

export const _grantWithoutExpiry = {
  access_mode: "continuous",
  client: { client_id: "research-app" },
  grant_id: "grt_no_expiry",
  issued_at: "2026-08-11T12:00:00Z",
  purpose_code: "https://pdpp.dev/purpose/research",
  source: { id: "https://sources.example/core/github", kind: "connector" },
  source_declaration: { version: "github-core-v1" },
  streams: [],
  subject: { id: "owner-1" },
  version: "0.1.0",
} satisfies ResolvedGrant;

// A string expiry remains valid -- normalization must never have removed the
// ability to express a real, bounded grant.
export const _grantWithExpiry = {
  ..._grantWithoutExpiry,
  expires_at: "2027-04-06T00:00:00Z",
} satisfies ResolvedGrant;

// --- 3. An explicit null must NOT type-check -----------------------------

// @ts-expect-error -- `expires_at: null` is the legacy representation this
// change eliminated. If nullable expiry is ever reintroduced into the public
// contract, this line stops erroring and `@ts-expect-error` itself becomes the
// compile failure -- which is exactly the regression signal we want.
export const _grantWithNullExpiry = { ..._grantWithoutExpiry, expires_at: null } satisfies ResolvedGrant;
