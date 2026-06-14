import { IcTimestamp } from "@pdpp/brand-react";
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../../../components/shell.tsx";
import { ReferenceServerUnreachableError, ResourceServerHttpError } from "../../../../lib/owner-token.ts";
import { type FieldHealth, type StreamHealth, streamHealth } from "../../../../lib/rs-client.ts";
import { connectorInstanceIdForConnection, resolveConnectionForRecordsRoute } from "../../../connection-route.ts";

export const dynamic = "force-dynamic";

const DEFAULT_SAMPLE = 2000;
const MAX_SAMPLE = 20_000;

const TH = "pdpp-eyebrow border-border/70 border-b px-3 py-2 text-left text-muted-foreground";
const TD = "pdpp-caption border-border/70 border-b px-3 py-2 align-top";

export default async function StreamHealthPage({
  params,
  searchParams,
}: {
  params: Promise<{ connector: string; stream: string }>;
  searchParams: Promise<{ sample?: string }>;
}) {
  const { connector, stream } = await params;
  const { sample } = await searchParams;
  const routeId = decodeURIComponent(connector);
  const streamName = decodeURIComponent(stream);

  const parsedSample = Number.parseInt(sample ?? "", 10);
  const sampleSize =
    Number.isFinite(parsedSample) && parsedSample > 0 ? Math.min(parsedSample, MAX_SAMPLE) : DEFAULT_SAMPLE;

  let health: StreamHealth;
  let connectorId = routeId;
  let connectionId = routeId;
  try {
    const connection = await resolveConnectionForRecordsRoute(routeId);
    if (!connection) {
      notFound();
    }
    connectorId = connection.connector_id;
    connectionId = connection.connection_id;
    health = await streamHealth(connectorId, streamName, {
      connectorInstanceId: connectorInstanceIdForConnection(connection),
      sampleSize,
    });
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Stream health" />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    if (err instanceof ResourceServerHttpError && (err.status === 404 || err.status === 410)) {
      // The stream's records read returned 404/410 — the connector no longer
      // advertises this stream (renamed/retired in a newer manifest, or a stale
      // entry not yet reconciled). The sibling records list and record-detail
      // pages already handle this; the health view is reachable from the list
      // page's "Stream health →" link, so it must degrade the same calm way
      // instead of crashing to the records segment error boundary.
      return <StreamHealthUnavailable connectionId={connectionId} streamName={streamName} />;
    }
    throw err;
  }

  return <StreamHealthReport connectionId={connectionId} health={health} streamName={streamName} />;
}

// Success render for the health view. Extracted from the page loader so the
// loader stays a thin data-fetch + error-handler; all the per-field/summary
// render branches live here, in a presentational component.
function StreamHealthReport({
  connectionId,
  health,
  streamName,
}: {
  connectionId: string;
  health: StreamHealth;
  streamName: string;
}) {
  const { fields, summary, emittedAt, cursorField, cursorRange } = health;
  const streamPath = `/dashboard/records/${encodeURIComponent(connectionId)}/${encodeURIComponent(streamName)}`;

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        breadcrumbs={[
          { label: "Sources", href: "/dashboard/records" },
          { label: connectionId, href: `/dashboard/records/${encodeURIComponent(connectionId)}` },
          { label: streamName, href: streamPath },
          { label: "health" },
        ]}
        count={
          <>
            sample {health.sampled.toLocaleString()} / {health.totalRecords.toLocaleString()}
            {health.limited ? " · sample-based" : ""}
          </>
        }
        title={
          <>
            <code className="font-mono">{streamName}</code>{" "}
            <span className="font-normal text-muted-foreground">· health</span>
          </>
        }
      />

      <Section title="Summary">
        <p className="pdpp-body break-words">
          <Stat label="declared" n={summary.declared} />
          <Stat label="present" n={summary.present} />
          <Stat label="entirely null" n={summary.entirelyNull} warn={summary.entirelyNull > 0} />
          <Stat label="const-valued" n={summary.constValued} />
          {summary.declaredButAbsent > 0 && <Stat label="declared-but-absent" n={summary.declaredButAbsent} warn />}
          {summary.undeclaredPresent > 0 && <Stat label="undeclared-but-present" n={summary.undeclaredPresent} warn />}
        </p>
        {health.limited && (
          <p className="pdpp-caption mt-2 text-muted-foreground">
            Sample limited to {health.sampleLimit.toLocaleString()} records; results are not authoritative for the full{" "}
            {health.totalRecords.toLocaleString()}-record stream. Raise via{" "}
            <code className="rounded bg-muted px-1 font-mono">?sample=N</code> (max {MAX_SAMPLE.toLocaleString()}).
          </p>
        )}
      </Section>

      <Section title="Freshness">
        <div className="overflow-x-auto rounded-md border border-border/70">
          <table className="min-w-full">
            <thead className="bg-muted/40">
              <tr>
                <th className={TH}>field</th>
                <th className={TH}>min</th>
                <th className={TH}>max</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={`${TD} font-mono`}>emitted_at</td>
                <td className={`${TD} whitespace-nowrap tabular-nums`}>
                  {emittedAt.min ? <IcTimestamp value={emittedAt.min} /> : <Dash />}
                </td>
                <td className={`${TD} whitespace-nowrap tabular-nums`}>
                  {emittedAt.max ? <IcTimestamp value={emittedAt.max} /> : <Dash />}
                </td>
              </tr>
              {cursorField && (
                <tr>
                  <td className={`${TD} font-mono`}>
                    {cursorField} <span className="text-muted-foreground">(cursor)</span>
                  </td>
                  <td className={`${TD} whitespace-nowrap tabular-nums`}>{cursorRange?.min ?? <Dash />}</td>
                  <td className={`${TD} whitespace-nowrap tabular-nums`}>{cursorRange?.max ?? <Dash />}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {!cursorField && (
          <p className="pdpp-caption mt-2 text-muted-foreground italic">
            Manifest declares no cursor_field for this stream.
          </p>
        )}
      </Section>

      <Section title={`Fields (${fields.length})`}>
        {fields.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">No fields in manifest or sample.</p>
        ) : (
          <>
            {/* Mobile */}
            <ul className="divide-y divide-border/70 border-border/70 border-y sm:hidden">
              {fields.map((f) => (
                <li className={`px-3 py-3 ${rowBg(f)}`} key={f.name}>
                  <FieldCard field={f} sampled={health.sampled} />
                </li>
              ))}
            </ul>

            {/* Desktop */}
            <div className="hidden overflow-x-auto rounded-md border border-border/70 sm:block">
              <table className="min-w-full">
                <thead className="bg-muted/40">
                  <tr>
                    <th className={TH}>field</th>
                    <th className={TH}>declared</th>
                    <th className={TH}>present</th>
                    <th className={TH}>null %</th>
                    <th className={TH}>distinct</th>
                    <th className={TH}>example</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f) => (
                    <tr className={rowBg(f)} key={f.name}>
                      <td className={`${TD} whitespace-nowrap font-mono`}>
                        <span className="break-all font-medium">{f.name}</span>
                        {flagLabels(f).map((lbl) => (
                          <Fragment key={lbl}>
                            {" "}
                            <span className="text-[color:var(--warning)]">{lbl}</span>
                          </Fragment>
                        ))}
                      </td>
                      <td className={TD}>{f.declared ? "yes" : <span className="text-muted-foreground">no</span>}</td>
                      <td className={TD}>{f.present ? "yes" : <span className="text-muted-foreground">no</span>}</td>
                      <td className={`${TD} whitespace-nowrap tabular-nums`}>{nullPct(f, health.sampled)}</td>
                      <td className={`${TD} whitespace-nowrap tabular-nums`}>
                        {f.distinctValues}
                        {f.distinctCapped ? "+" : ""}
                      </td>
                      <td className={`${TD} text-muted-foreground`}>
                        <span className="block max-w-[24rem] truncate" title={f.sampleValue ?? ""}>
                          {f.sampleValue ?? ""}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>
    </RecordroomShellWithPalette>
  );
}

// Bounded "this stream is gone" state for the health view. Mirrors the
// stream-list page's `not available` surface so a retired/renamed stream
// reached via the "Stream health →" link degrades calmly instead of crashing
// to the records segment error boundary.
function StreamHealthUnavailable({ connectionId, streamName }: { connectionId: string; streamName: string }) {
  return (
    <RecordroomShellWithPalette>
      <PageHeader
        breadcrumbs={[
          { label: "Sources", href: "/dashboard/records" },
          { label: connectionId, href: `/dashboard/records/${encodeURIComponent(connectionId)}` },
          { label: streamName },
          { label: "health" },
        ]}
        title={
          <>
            <code className="font-mono">{streamName}</code>{" "}
            <span className="font-normal text-muted-foreground">· health</span>
          </>
        }
      />
      <div className="rounded-md border border-border/70 bg-muted/30 p-4">
        <p className="pdpp-caption text-foreground">
          Stream health is not available for <code className="font-mono">{streamName}</code>.
        </p>
        <p className="pdpp-caption mt-2 text-muted-foreground">
          The connector no longer advertises a stream named <code className="font-mono">{streamName}</code>. It may have
          been renamed or retired in a newer manifest, or the stream list is showing a stale entry that has not yet been
          reconciled. Return to{" "}
          <Link
            className="underline underline-offset-2"
            href={`/dashboard/records/${encodeURIComponent(connectionId)}`}
          >
            the connection page
          </Link>{" "}
          to see currently available streams.
        </p>
      </div>
    </RecordroomShellWithPalette>
  );
}

function Stat({ n, label, warn = false }: { n: number; label: string; warn?: boolean }) {
  return (
    <>
      <span className={`font-medium tabular-nums ${warn && n > 0 ? "text-[color:var(--warning)]" : ""}`}>{n}</span>{" "}
      <span className="text-muted-foreground">{label}</span>
      {" · "}
    </>
  );
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

function nullPct(f: FieldHealth, sampled: number): string {
  if (sampled === 0) {
    return "—";
  }
  const total = f.nullCount + f.nonNullCount;
  if (total === 0) {
    return "—";
  }
  const pct = (f.nullCount / total) * 100;
  return `${pct.toFixed(pct === 100 || pct === 0 ? 0 : 1)}%`;
}

function flagLabels(f: FieldHealth): string[] {
  const flags: string[] = [];
  if (f.declared && !f.present) {
    flags.push("[absent]");
  }
  if (!f.declared && f.present) {
    flags.push("[undeclared]");
  }
  if (f.present && f.nonNullCount === 0) {
    flags.push("[all-null]");
  }
  if (f.nonNullCount > 0 && f.distinctValues === 1) {
    flags.push("[const]");
  }
  return flags;
}

function rowBg(f: FieldHealth): string {
  const flagged =
    (f.declared && !f.present) ||
    (!f.declared && f.present) ||
    (f.present && f.nonNullCount === 0) ||
    (f.nonNullCount > 0 && f.distinctValues === 1);
  return flagged ? "bg-[color:var(--warning-wash)]" : "";
}

function FieldCard({ field: f, sampled }: { field: FieldHealth; sampled: number }) {
  return (
    <dl className="pdpp-caption grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      <dt className="text-muted-foreground">field</dt>
      <dd className="break-all font-mono">
        <span className="font-medium">{f.name}</span>
        {flagLabels(f).map((lbl) => (
          <Fragment key={lbl}>
            {" "}
            <span className="text-[color:var(--warning)]">{lbl}</span>
          </Fragment>
        ))}
      </dd>
      <dt className="text-muted-foreground">declared</dt>
      <dd>{f.declared ? "yes" : "no"}</dd>
      <dt className="text-muted-foreground">present</dt>
      <dd>{f.present ? "yes" : "no"}</dd>
      <dt className="text-muted-foreground">null %</dt>
      <dd className="tabular-nums">{nullPct(f, sampled)}</dd>
      <dt className="text-muted-foreground">distinct</dt>
      <dd className="tabular-nums">
        {f.distinctValues}
        {f.distinctCapped ? "+" : ""}
      </dd>
      {f.sampleValue && (
        <>
          <dt className="text-muted-foreground">example</dt>
          <dd className="break-words text-muted-foreground">{f.sampleValue}</dd>
        </>
      )}
    </dl>
  );
}
