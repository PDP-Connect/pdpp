import type { Metadata } from "next";
import { SandboxOverviewContent } from "./overview-content.tsx";

export const metadata: Metadata = {
  title: "PDPP reference instance · Sandbox",
  description:
    "Inspect the PDPP reference dashboard as a mock owner. Deterministic fictional data, no credentials, no live calls.",
};

export const dynamic = "force-static";

export default function SandboxPage() {
  return <SandboxOverviewContent />;
}
