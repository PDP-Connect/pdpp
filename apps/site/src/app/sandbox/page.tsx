// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { SandboxOverviewContent } from "./overview-content.tsx";

export const metadata: Metadata = {
  description: "Explore a mock-adapter-backed PDPP reference instance with a complete reference data profile.",
  title: "PDPP reference instance · Sandbox",
};

export const dynamic = "force-static";

export default function SandboxPage() {
  return <SandboxOverviewContent />;
}
