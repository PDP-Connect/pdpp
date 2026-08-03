// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { OwnerIssuedClient } from "../../lib/ref-client.ts";

/**
 * Cleanup order: never-used credentials first (highest risk — live access,
 * zero usage), then least-recently-used. Issuance order is the wrong default
 * for a page whose main job is revoking stale credentials.
 *
 * Split into its own module (no React/JSX/CSS import chain) so it is
 * directly unit-testable: `page.tsx` transitively imports `.css` via
 * `@pdpp/brand-react`, which a plain Node test runner cannot load, so a
 * pure comparator entangled with that import graph could only ever be
 * proven by source-regex matching the call site — which proves the sort is
 * CALLED, not that it actually orders never-used first.
 */
export function byCleanupPriority(a: OwnerIssuedClient, b: OwnerIssuedClient): number {
  if (!(a.last_used_at || b.last_used_at)) {
    return a.created_at.localeCompare(b.created_at);
  }
  if (!a.last_used_at) {
    return -1;
  }
  if (!b.last_used_at) {
    return 1;
  }
  return a.last_used_at.localeCompare(b.last_used_at);
}
