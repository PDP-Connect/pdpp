// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Spec sentences that carry an uppercase MUST-family keyword but are not
// obligations, so the completeness test (test/spec-completeness.test.ts) does
// not demand a matrix clause for them.
//
// Every entry needs a one-line reason. The test fails on an entry that no
// longer matches a sentence of spec-core.md, so this list cannot rot into a
// place where unmapped obligations are quietly parked.

export interface SpecSentenceExclusion {
  readonly reason: string;
  /** The sentence, after whitespace and markdown normalization, starts with this text. */
  readonly startsWith: string;
}

export const SPEC_SENTENCE_EXCLUSIONS: readonly SpecSentenceExclusion[] = [
  {
    startsWith: 'The key words "MUST", "MUST NOT", "REQUIRED"',
    reason: "Section 2 BCP 14 definition sentence: it defines the keywords and imposes no requirement of its own.",
  },
];
