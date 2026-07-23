// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/correctness/noUnresolvedImports: Biome 2.5.5 cannot resolve this pnpm package export; tsc and pnpm Node resolution validate it.
import { type ClassValue, clsx } from "clsx";
// biome-ignore lint/correctness/noUnresolvedImports: Biome 2.5.5 cannot resolve this pnpm package export; tsc and pnpm Node resolution validate it.
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
