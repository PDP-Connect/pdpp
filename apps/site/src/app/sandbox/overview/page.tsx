// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { SandboxOverviewContent } from "../overview-content.tsx";

export const metadata: Metadata = {
  title: "PDPP reference instance · Overview",
  description: "Overview of the PDPP reference dashboard, bound to deterministic mock AS/RS data.",
};

export const dynamic = "force-static";

export default function SandboxOverviewPage() {
  return <SandboxOverviewContent />;
}
