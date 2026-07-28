// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const NULLISH_VALUES: readonly unknown[] = [null, undefined];

/**
 * Narrow an untrusted boundary value to JavaScript's two absent-value forms.
 *
 * This intentionally centralizes the `null`/`undefined` pair so callers do not
 * need either a loose-equality lint exception or duplicated control flow.
 */
export function isNullish(value: unknown): value is null | undefined {
  return NULLISH_VALUES.includes(value);
}
