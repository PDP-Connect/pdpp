"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

interface ConnectorOption {
  label: string;
  streams: string[];
  value: string;
}

export function SearchFiltersForm({
  query,
  connectorFilter,
  streamFilter,
  sortOrder,
  connectorOptions,
}: {
  query: string;
  connectorFilter: string;
  streamFilter: string;
  sortOrder: string;
  connectorOptions: ConnectorOption[];
}) {
  const [selectedConnector, setSelectedConnector] = useState(connectorFilter);
  const [selectedStream, setSelectedStream] = useState(streamFilter);

  const streamOptions = useMemo(() => {
    if (!selectedConnector) {
      return Array.from(new Set(connectorOptions.flatMap((option) => option.streams))).sort();
    }
    return (connectorOptions.find((option) => option.value === selectedConnector)?.streams ?? []).slice().sort();
  }, [connectorOptions, selectedConnector]);

  useEffect(() => {
    if (selectedStream && !streamOptions.includes(selectedStream)) {
      setSelectedStream("");
    }
  }, [selectedStream, streamOptions]);

  const hasActiveFilters = Boolean(query.trim() || selectedConnector || selectedStream || sortOrder !== "native:desc");

  return (
    <form
      className="mb-6 grid gap-2 md:grid-cols-[minmax(18rem,2fr)_minmax(11rem,1fr)_minmax(11rem,1fr)_minmax(12rem,1fr)_auto] md:items-end"
      method="get"
    >
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">query</span>
        <input
          autoFocus
          className="w-full rounded border border-border bg-background px-3 py-2"
          defaultValue={query}
          name="q"
          placeholder="trace id, connector, stream, or record text…"
          type="search"
        />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">connector</span>
        <select
          className="rounded border border-border bg-background px-3 py-2"
          name="connector_id"
          onChange={(event) => setSelectedConnector(event.target.value)}
          value={selectedConnector}
        >
          <option value="">all connectors</option>
          {connectorOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">stream</span>
        <select
          className="rounded border border-border bg-background px-3 py-2"
          name="stream"
          onChange={(event) => setSelectedStream(event.target.value)}
          value={selectedStream}
        >
          <option value="">all streams</option>
          {streamOptions.map((streamName) => (
            <option key={streamName} value={streamName}>
              {streamName}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">sort records by</span>
        <select
          className="rounded border border-border bg-background px-3 py-2"
          defaultValue={sortOrder}
          name="sort_order"
        >
          <option value="native:desc">newest native date first</option>
          <option value="native:asc">oldest native date first</option>
          <option value="ingested:desc">newest ingest first</option>
          <option value="ingested:asc">oldest ingest first</option>
        </select>
      </label>
      <button
        className="self-start rounded border border-border px-3 py-2 hover:bg-muted/50 md:self-auto"
        type="submit"
      >
        apply
      </button>
      {hasActiveFilters ? (
        <Link
          className="self-start px-1 py-2 text-muted-foreground text-xs underline-offset-2 hover:underline md:self-auto"
          href="/dashboard/search"
        >
          reset
        </Link>
      ) : null}
    </form>
  );
}
