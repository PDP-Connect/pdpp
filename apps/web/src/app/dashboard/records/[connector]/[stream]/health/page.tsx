import { Fragment } from "react";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { PageHeader, Section } from "../../../../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../../../../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../../../../lib/owner-token.ts";
import { type FieldHealth, type StreamHealth, streamHealth } from "../../../../lib/rs-client.ts";

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
  const connectorId = decodeURIComponent(connector);
  const streamName = decodeURIComponent(stream);

  const parsedSample = Number.parseInt(sample ?? "", 10);
  const sampleSize =
    Number.isFinite(parsedSample) && parsedSample > 0 ? Math.min(parsedSample, MAX_SAMPLE) : DEFAULT_SAMPLE;

  let health: StreamHealth;
  try {
    health = await streamHealth(connectorId, streamName, { sampleSize });
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <PageHeader title="Stream health" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const { fields, summary, emittedAt, cursorField, cursorRange } = health;
  const streamPath = `/dashboard/records/${encodeURIComponent(connectorId)}/${encodeURIComponent(streamName)}`;

  return (
    <DashboardShell active="records">
      <PageHeader
        breadcrumbs={[
          { label: "Records", href: "/dashboard/records" },
          { label: connectorId, href: `/dashboard/records/${encodeURIComponent(connectorId)}` },
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
                  {emittedAt.min ? <Timestamp value={emittedAt.min} /> : <Dash />}
                </td>
                <td className={`${TD} whitespace-nowrap tabular-nums`}>
                  {emittedAt.max ? <Timestamp value={emittedAt.max} /> : <Dash />}
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
    </DashboardShell>
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
