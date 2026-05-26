import type { CanonicalReadWarning } from "../lib/read-envelope.ts";

/**
 * Out-of-band surface for canonical `meta.warnings`. Renders nothing when
 * empty so callers can pass it through unconditionally. We never drop data
 * because of a warning — warnings are advisory by contract.
 *
 * The structured `code` is the source of truth; `message` is a short hint
 * when the runtime supplies it. We render both compactly to keep the
 * dashboard parseable when stacked warnings appear (e.g. a
 * `deprecated_alias_used` plus a `count_downgraded`).
 */
export function WarningsBanner({ warnings }: { warnings: CanonicalReadWarning[] }) {
  if (!warnings || warnings.length === 0) {
    return null;
  }
  return (
    <div
      aria-live="polite"
      className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
      role="status"
    >
      <p className="pdpp-eyebrow mb-1 text-amber-700 dark:text-amber-300">
        {warnings.length === 1 ? "Read warning" : `${warnings.length} read warnings`}
      </p>
      <ul className="pdpp-caption space-y-0.5">
        {warnings.map((w, i) => (
          <li className="text-foreground" key={`${w.code}:${i}`}>
            <code className="font-mono text-amber-700 dark:text-amber-300">{w.code}</code>
            {w.dropped_parameter ? (
              <>
                {" "}
                <span className="text-muted-foreground">dropped</span>{" "}
                <code className="font-mono">{w.dropped_parameter}</code>
              </>
            ) : null}
            {w.message ? <span className="text-muted-foreground"> — {w.message}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
