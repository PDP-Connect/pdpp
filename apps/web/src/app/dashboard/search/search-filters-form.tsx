'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type ConnectorOption = {
  value: string;
  label: string;
  streams: string[];
};

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
      return Array.from(
        new Set(connectorOptions.flatMap((option) => option.streams)),
      ).sort();
    }
    return (
      connectorOptions.find((option) => option.value === selectedConnector)?.streams ?? []
    ).slice().sort();
  }, [connectorOptions, selectedConnector]);

  useEffect(() => {
    if (selectedStream && !streamOptions.includes(selectedStream)) {
      setSelectedStream('');
    }
  }, [selectedStream, streamOptions]);

  const hasActiveFilters = Boolean(
    query.trim() || selectedConnector || selectedStream || sortOrder !== 'native:desc',
  );

  return (
    <form
      method="get"
      className="mb-6 grid gap-2 md:grid-cols-[minmax(18rem,2fr)_minmax(11rem,1fr)_minmax(11rem,1fr)_minmax(12rem,1fr)_auto] md:items-end"
    >
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">query</span>
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="trace id, connector, stream, or record text…"
          className="border-border bg-background w-full rounded border px-3 py-2"
          autoFocus
        />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">connector</span>
        <select
          name="connector_id"
          value={selectedConnector}
          onChange={(event) => setSelectedConnector(event.target.value)}
          className="border-border bg-background rounded border px-3 py-2"
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
          name="stream"
          value={selectedStream}
          onChange={(event) => setSelectedStream(event.target.value)}
          className="border-border bg-background rounded border px-3 py-2"
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
          name="sort_order"
          defaultValue={sortOrder}
          className="border-border bg-background rounded border px-3 py-2"
        >
          <option value="native:desc">newest native date first</option>
          <option value="native:asc">oldest native date first</option>
          <option value="ingested:desc">newest ingest first</option>
          <option value="ingested:asc">oldest ingest first</option>
        </select>
      </label>
      <button
        type="submit"
        className="border-border hover:bg-muted/50 self-start rounded border px-3 py-2 md:self-auto"
      >
        apply
      </button>
      {hasActiveFilters ? (
        <Link
          href="/dashboard/search"
          className="text-muted-foreground self-start px-1 py-2 text-xs underline-offset-2 hover:underline md:self-auto"
        >
          reset
        </Link>
      ) : null}
    </form>
  );
}
