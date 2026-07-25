// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { accountingEventLine } from "./receipt.ts";

interface ReporterEventData {
  details?: { type?: string; name?: string; skip?: boolean | string };
  name?: string;
  skip?: boolean | string;
}
interface ReporterEvent {
  data?: ReporterEventData;
  type: string;
}

// Node's reporter stream is the runner's structured API. Keep only the fields
// accounting needs, so transcripts remain stable across Node's presentation
// reporters and cannot be mistaken for TAP text summaries.
export default async function* accountingReporter(source: AsyncIterable<ReporterEvent>): AsyncGenerator<string> {
  for await (const event of source) {
    const data = event.data ?? {};
    const details = data.details ?? {};
    yield `${accountingEventLine({ type: event.type, details: { type: details.type, name: data.name ?? details.name, skip: data.skip ?? details.skip } })}\n`;
  }
}
