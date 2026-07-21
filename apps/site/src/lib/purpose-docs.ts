// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP purpose code documents.
 *
 * In PDPP, a purpose_code is a dereferenceable URI. Resolving it returns a
 * machine-readable document that defines what the purpose permits and forbids.
 * This module provides the client-side representations of those documents.
 */

export interface PurposeDoc {
  description: string;
  label: string;
  max_retention: string; // ISO 8601 duration, e.g. "P1Y"
  permitted_uses: string[];
  prohibited_uses: string[];
  requires_explicit_consent: boolean;
  uri: string;
}

export const PDPP_PURPOSE_DOCS: Record<string, PurposeDoc> = {
  "https://pdpp.org/purpose/research": {
    uri: "https://pdpp.org/purpose/research",
    label: "research",
    description: "Academic or market research that produces aggregate, non-identifying findings.",
    permitted_uses: [
      "Aggregate statistical analysis",
      "Network topology and influence studies",
      "Published academic findings (anonymized)",
    ],
    prohibited_uses: [
      "Advertising targeting or retargeting",
      "Training machine learning models",
      "Resale or transfer to third parties",
      "Individual-level profiling",
    ],
    max_retention: "P1Y",
    requires_explicit_consent: false,
  },
  "https://pdpp.org/purpose/ai_training": {
    uri: "https://pdpp.org/purpose/ai_training",
    label: "ai_training",
    description:
      "Training or fine-tuning machine learning models. Requires explicit affirmative consent and may persist beyond a single session.",
    permitted_uses: [
      "Training or fine-tuning ML recommendation models",
      "Improving content ranking and personalization",
    ],
    prohibited_uses: [
      "Advertising targeting",
      "Resale or transfer to third parties",
      "Identity verification or background checks",
    ],
    max_retention: "P3Y",
    requires_explicit_consent: true,
  },
};
