// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { cn as brandCn } from "@pdpp/brand/tw-merge";
import type { ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return brandCn(...inputs);
}
