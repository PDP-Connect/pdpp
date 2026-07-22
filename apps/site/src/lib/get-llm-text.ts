// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { InferPageType } from "fumadocs-core/source";
import type { source } from "@/lib/docs-source.ts";

export async function getLLMText(page: InferPageType<typeof source>) {
  const processed = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})\n\n${processed}`;
}
