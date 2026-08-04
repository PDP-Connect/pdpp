// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { ReferenceApp } from "@/components/reference-app.tsx";

export const metadata: Metadata = {
  description:
    "An interactive walkthrough of the PDPP protocol: a synthetic app requests data, the owner grants a scoped consent, and the resource server enforces it end to end.",
  title: "Live protocol walkthrough · Sandbox · PDPP",
};

export default function SandboxDemoPage() {
  return <ReferenceApp currentLabel="Sandbox / Live walkthrough" />;
}
