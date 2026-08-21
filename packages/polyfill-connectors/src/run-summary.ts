// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure reduction of a connector's protocol message stream into a
 * mechanically-produced run summary.
 *
 * `bin/connector-dev.ts` is the "run and watch it work" developer command:
 * it runs one connector the real way (spawns its entrypoint, drives the
 * Collection Profile protocol over stdio) and streams what happens live.
 * This module is the other half — turning that same message stream into a
 * durable JSON artifact so "it worked" is a file with counts in it, not a
 * paragraph a person or an agent wrote from memory.
 *
 * `buildRunSummary` takes no dependency on the CLI, the child process, or
 * the filesystem — it is a fold over `EmittedMessage[]`, so its behavior is
 * fully pinned by unit tests without spawning anything.
 */

import type { DetailCoverageMessage, EmittedMessage } from "@pdpp/connector-protocol/connector-runtime-protocol";

export interface RunSummaryStream {
  /**
   * Wall-clock span of this stream's own record emission: the gap between its
   * first and last RECORD's `emitted_at`. Absent for a stream that emitted no
   * records (or whose records carried no usable timestamp).
   *
   * Present because a total duration alone cannot tell an author WHERE a long
   * run went. Observed live 2026-08-14: a real ynab run took 75 minutes, of
   * which one stream (`month_categories`, 140 paced monthly windows at the
   * connector's audited ~20s/request ceiling) dominated — invisible in a
   * summary that reported only 11,908 records and a total. Derived from
   * timestamps the protocol already carries, not new instrumentation.
   */
  elapsed_ms?: number;
  /** ISO timestamp of this stream's first RECORD, when it emitted any. */
  first_record_at?: string;
  /** ISO timestamp of this stream's last RECORD, when it emitted any. */
  last_record_at?: string;
  records: number;
  /**
   * Whether a STATE message for this stream was OBSERVED ON THE WIRE anywhere
   * in this run — i.e. the connector emitted it. Named `state_emitted`
   * (not `state_committed`): `connector-dev` never writes to a real Record
   * Store (see this module's docstring — no RS durability path runs here), so
   * "committed" would claim a persistence guarantee this tool cannot make.
   * "Emitted" is the honest claim: the message crossed the wire, nothing more.
   */
  state_emitted: boolean;
}

export interface RunSummaryCoverage {
  considered: number;
  covered: number;
  /** Streams for which at least one DETAIL_COVERAGE message was observed. */
  streams: readonly string[];
}

export interface RunSummaryDone {
  coverage?: RunSummaryCoverage;
  error?: {
    message: string;
    retryable: boolean;
    code?: string;
  };
  /**
   * ISO-8601 timestamp of the most recent RECORD.emitted_at seen in the run,
   * when any RECORD was emitted. Named `latest_record_emitted_at` (not
   * `freshness`): `emitted_at` is stamped when the connector PROCESSED the
   * record during this run, not when the underlying source data last
   * changed — it says nothing about how fresh the source content actually
   * is, so calling it "freshness" overclaims. This is processing time, not
   * source freshness.
   */
  latest_record_emitted_at?: string;
  status: "succeeded" | "failed" | "no_done";
}

export interface RunSummary {
  connector: string;
  done: RunSummaryDone;
  duration_ms: number;
  finished_at: string;
  format: "pdpp.run-summary/1";
  generated_by: "connector-dev";
  /**
   * ALWAYS `false` — `connector-dev` has no transport-observation layer. It
   * spawns the connector's own entrypoint and reads its stdout JSONL
   * directly (see this file's module docstring); unlike
   * `bin/scenario-record.ts`'s recording preload (which patches
   * `globalThis.fetch` and can therefore mechanically observe whether any
   * request reached a non-loopback authority — see format.ts's
   * `ScenarioProviderContact`), this tool never wraps the subprocess's
   * `fetch` at all, so it has no evidence about what the connector actually
   * contacted, or whether it contacted anything. A connector run that
   * SUCCEEDS here proves the protocol was driven correctly; it does NOT
   * prove real provider contact. An `evidence_class: "derived-from-real"`
   * claim (format.ts's `ScenarioEvidenceClass`) requires scenario-record's
   * OWN observation — this field exists so a caller reading a
   * `connector-dev` run-summary in isolation cannot mistake a successful run
   * here for that evidence.
   */
  provider_contact_observed: false;
  skips: number;
  started_at: string;
  streams: Record<string, RunSummaryStream>;
  tool_version: string;
}

export interface RunSummaryMeta {
  connector: string;
  finished_at: string;
  started_at: string;
  tool_version: string;
}

function isDetailCoverageMessage(message: EmittedMessage): message is DetailCoverageMessage {
  return message.type === "DETAIL_COVERAGE";
}

function streamFor(name: string, streams: Record<string, RunSummaryStream>): RunSummaryStream {
  const existing = streams[name];
  if (existing) {
    return existing;
  }
  const created: RunSummaryStream = { records: 0, state_emitted: false };
  streams[name] = created;
  return created;
}

function latestRecordEmittedAt(messages: readonly EmittedMessage[]): string | undefined {
  let latest: string | undefined;
  for (const message of messages) {
    if (message.type !== "RECORD") {
      continue;
    }
    const { emitted_at: emittedAt } = message;
    if (typeof emittedAt === "string" && emittedAt && (!latest || emittedAt > latest)) {
      latest = emittedAt;
    }
  }
  return latest;
}

function buildCoverage(messages: readonly EmittedMessage[]): RunSummaryCoverage | undefined {
  const coverageMessages = messages.filter(isDetailCoverageMessage);
  if (coverageMessages.length === 0) {
    return;
  }
  const streamNames = new Set<string>();
  let considered = 0;
  let covered = 0;
  for (const message of coverageMessages) {
    streamNames.add(message.stream);
    considered += message.considered ?? message.required_keys.length;
    covered += message.covered ?? message.hydrated_keys.length;
  }
  return { considered, covered, streams: [...streamNames] };
}

function buildDone(messages: readonly EmittedMessage[]): RunSummaryDone {
  const done = messages.findLast((message) => message.type === "DONE");
  const coverage = buildCoverage(messages);
  const latestRecordEmittedAtValue = latestRecordEmittedAt(messages);
  if (!done) {
    return {
      status: "no_done",
      ...(coverage ? { coverage } : {}),
      ...(latestRecordEmittedAtValue ? { latest_record_emitted_at: latestRecordEmittedAtValue } : {}),
    };
  }
  return {
    status: done.status,
    ...(coverage ? { coverage } : {}),
    ...(latestRecordEmittedAtValue ? { latest_record_emitted_at: latestRecordEmittedAtValue } : {}),
    ...(done.status === "failed" && done.error
      ? {
          error: {
            message: done.error.message,
            retryable: done.error.retryable,
            ...(done.error.code ? { code: done.error.code } : {}),
          },
        }
      : {}),
  };
}

/**
 * Widen a stream's observed `emitted_at` window. Records arrive in emission
 * order per stream but interleave across streams, and `emitted_at` is
 * connector-supplied, so neither bound can be assumed from arrival position.
 * Non-string and empty timestamps leave the window untouched.
 */
function widenRecordWindow(stream: RunSummaryStream, emittedAt: unknown): void {
  if (typeof emittedAt !== "string" || !emittedAt) {
    return;
  }
  if (!stream.first_record_at || emittedAt < stream.first_record_at) {
    stream.first_record_at = emittedAt;
  }
  if (!stream.last_record_at || emittedAt > stream.last_record_at) {
    stream.last_record_at = emittedAt;
  }
}

/**
 * Fold a connector's protocol message stream into a `RunSummary`.
 *
 * Edge cases this handles explicitly (see `src/run-summary.test.ts`):
 *   - No STATE ever emitted for a stream that produced records — the
 *     stream's `state_emitted` stays `false` so a developer can see a
 *     connector emitted records but never even sent a checkpoint message
 *     (this tool makes no claim about durable commit either way — see
 *     `RunSummaryStream.state_emitted`'s doc comment).
 *   - A run that fails mid-stream (no terminal DONE at all, or a DONE with
 *     `status: "failed"`) still gets a well-formed summary with whatever
 *     partial per-stream counts were observed before failure.
 *   - Multiple streams interleaved in the message order — counts are
 *     attributed per-`stream` field, not per-arrival-order.
 */
export function buildRunSummary(messages: readonly EmittedMessage[], meta: RunSummaryMeta): RunSummary {
  const streams: Record<string, RunSummaryStream> = {};
  let skips = 0;

  for (const message of messages) {
    if (message.type === "RECORD") {
      const stream = streamFor(message.stream, streams);
      stream.records += 1;
      widenRecordWindow(stream, message.emitted_at);
    } else if (message.type === "STATE") {
      streamFor(message.stream, streams).state_emitted = true;
    } else if (message.type === "SKIP_RESULT") {
      skips += 1;
    }
  }

  for (const stream of Object.values(streams)) {
    if (stream.first_record_at && stream.last_record_at) {
      const span = Date.parse(stream.last_record_at) - Date.parse(stream.first_record_at);
      if (Number.isFinite(span) && span >= 0) {
        stream.elapsed_ms = span;
      }
    }
  }

  const startedMs = Date.parse(meta.started_at);
  const finishedMs = Date.parse(meta.finished_at);
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : 0;

  return {
    format: "pdpp.run-summary/1",
    connector: meta.connector,
    tool_version: meta.tool_version,
    started_at: meta.started_at,
    finished_at: meta.finished_at,
    duration_ms: durationMs,
    streams,
    skips,
    done: buildDone(messages),
    generated_by: "connector-dev",
    provider_contact_observed: false,
  };
}
