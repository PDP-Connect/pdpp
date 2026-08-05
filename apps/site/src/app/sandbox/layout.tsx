// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import type { ReactNode } from "react";

// The sandbox is a mock-adapter-backed demo instance, not real protocol
// content — indexing synthetic data as if it were canonical PDPP content
// would misrepresent the page (SEO/GEO standard MUST #1.5: robots directives
// must agree with the approved access policy). noindex applies to every route
// under /sandbox because Next merges metadata down the segment tree.
export const metadata: Metadata = {
  robots: { follow: false, index: false },
};

export default function SandboxLayout({ children }: { children: ReactNode }) {
  return children;
}
