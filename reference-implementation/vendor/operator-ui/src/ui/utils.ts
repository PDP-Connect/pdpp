// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { cn as brandCn } from "@pdpp/brand/tw-merge";
// biome-ignore lint/correctness/noUnresolvedImports: Biome can't resolve pnpm package exports; tsc validates.
import type { ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return brandCn(...inputs);
}
