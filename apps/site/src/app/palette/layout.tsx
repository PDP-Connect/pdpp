// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isContributorSurfaceEnabled } from "@/lib/contributor-surface.ts";

// Read env at request time so the gate can flip without a rebuild.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: "noindex, nofollow",
};

export default function PaletteLayout({ children }: { children: ReactNode }) {
  if (!isContributorSurfaceEnabled()) {
    notFound();
  }
  return children;
}
