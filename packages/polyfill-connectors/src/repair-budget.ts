// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Run-scoped cap on credentialed self-heal attempts (e.g. an automated
 * login triggered by a mid-run session death). One instance must be shared
 * across every stream/entry-point a single run touches — constructing a
 * fresh budget per stream (or per call) defeats the cap, since each fresh
 * instance starts unspent. This is deliberately just a counter: what
 * "spending" a repair attempt means (browser re-login, API token refresh,
 * whether a failed attempt still counts) is provider-specific and stays in
 * each connector.
 */
export function createRepairBudget(maxAttempts = 1): { tryConsume: () => boolean } {
  let spent = 0;
  return {
    tryConsume(): boolean {
      if (spent >= maxAttempts) {
        return false;
      }
      spent += 1;
      return true;
    },
  };
}
