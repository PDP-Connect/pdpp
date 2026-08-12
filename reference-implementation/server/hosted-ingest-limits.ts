// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Current hosted NDJSON request ceiling, shared by transport and durable rejection storage. */
export const HOSTED_INGEST_MAX_REQUEST_BYTES = 50 * 1024 * 1024;

/** A single NDJSON line cannot exceed the request that carries it. */
export const HOSTED_INGEST_MAX_LINE_BYTES = HOSTED_INGEST_MAX_REQUEST_BYTES;
