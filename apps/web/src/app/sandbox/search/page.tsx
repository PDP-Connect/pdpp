import Link from "next/link";
import { buildSearchResponse } from "../_demo/builders.ts";
import { CodeBlock, InlineCode } from "../_demo/components/code-block.tsx";
import { SandboxShell } from "../_demo/components/shell.tsx";

// Search reads query-string state; static prerendering drops `?q=...`.
export const dynamic = "force-dynamic";

const SUGGESTIONS = ["payroll", "Northwind", "follow-up", "Bluebird", "income"] as const;

export default async function SandboxSearchPage(props: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await props.searchParams;
  const query = (q ?? "").trim();
  const results = buildSearchResponse(query);

  return (
    <SandboxShell active="search">
      <header className="mb-6 border-border/80 border-b pb-5">
        <div className="pdpp-eyebrow text-muted-foreground">Sandbox / Search</div>
        <h1 className="pdpp-heading mt-2 text-foreground">Lexical search</h1>
        <p className="pdpp-body mt-2 max-w-3xl text-muted-foreground">
          Free-text search across all seeded fictional records. Results show which fields matched and a short snippet.
          Backed by <InlineCode>/sandbox/v1/search</InlineCode>.
        </p>
      </header>

      <form action="/sandbox/search" className="mb-8 flex max-w-2xl gap-2" method="get">
        <input
          aria-label="Search query"
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-foreground"
          defaultValue={query}
          name="q"
          placeholder="payroll, Northwind, follow-up…"
          type="text"
        />
        <button
          className="rounded-md border border-border bg-foreground px-4 py-2 text-background hover:opacity-90"
          type="submit"
        >
          Search
        </button>
      </form>

      <div className="mb-8 flex flex-wrap items-center gap-2 text-sm">
        <span className="pdpp-eyebrow text-muted-foreground">Try</span>
        {SUGGESTIONS.map((s) => (
          <Link
            className="rounded-full border border-border px-2.5 py-0.5 text-muted-foreground hover:border-foreground hover:text-foreground"
            href={`/sandbox/search?q=${encodeURIComponent(s)}`}
            key={s}
          >
            {s}
          </Link>
        ))}
      </div>

      {query.length === 0 ? (
        <p className="pdpp-body text-muted-foreground">Enter a query to search seeded records.</p>
      ) : (
        <section>
          <h2 className="pdpp-title mb-3 text-foreground">
            {results.total} {results.total === 1 ? "match" : "matches"} for <InlineCode>{query}</InlineCode>
          </h2>
          {results.data.length === 0 ? (
            <p className="pdpp-body text-muted-foreground">No matches in seeded records.</p>
          ) : (
            <ul className="divide-y divide-border/70 border-border/70 border-y">
              {results.data.map((hit) => (
                <li className="px-3 py-3" key={hit.record_key}>
                  <Link
                    className="block"
                    href={`/sandbox/records/${encodeURIComponent(hit.stream)}/${encodeURIComponent(hit.record_key)}`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <code className="pdpp-caption break-all font-medium font-mono text-foreground">
                        {hit.record_key}
                      </code>
                      <span className="pdpp-caption text-muted-foreground">
                        {hit.connector_id} · {hit.stream}
                      </span>
                    </div>
                    <div className="pdpp-caption mt-1 text-muted-foreground">
                      {hit.snippet.field}: {hit.snippet.text}
                    </div>
                    <div className="pdpp-eyebrow mt-1 text-muted-foreground">
                      matched: {hit.matched_fields.join(", ")}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="mt-10">
        <h2 className="pdpp-title mb-3 text-foreground">API example</h2>
        <CodeBlock language="shell">{`curl -s '/sandbox/v1/search?q=${encodeURIComponent(query || "payroll")}'`}</CodeBlock>
      </section>
    </SandboxShell>
  );
}
