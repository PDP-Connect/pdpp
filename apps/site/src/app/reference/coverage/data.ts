import "server-only";

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type CoverageCategory =
  | "Protocol flow"
  | "Retrieval extension"
  | "Collection profile"
  | "Reference control plane"
  | "Sandbox"
  | "Deferred scope";

export type CoverageState = "yes" | "partial" | "no" | "not-applicable";

export type CoverageStatus = "implemented" | "partial" | "deferred" | "planned" | "reference-only";

export interface CoverageEvidence {
  href: string;
  label: string;
  sourcePath: string;
}

export interface CoverageRow {
  category: CoverageCategory;
  concept: string;
  demonstrated: CoverageState;
  documented: CoverageState;
  evidence: readonly CoverageEvidence[];
  implemented: CoverageState;
  notes: string;
  specified: CoverageState;
  status: CoverageStatus;
  tested: CoverageState;
}

const repoRoot = process.cwd().endsWith("apps/web") ? resolve(process.cwd(), "..", "..") : process.cwd();
const rootRelative = (sourcePath: string) => resolve(repoRoot, sourcePath);

const docs = (slug: string, label: string): CoverageEvidence => ({
  label,
  href: `/docs/${slug}`,
  sourcePath: `apps/web/content/docs/${slug}.md`,
});

const referenceDocs = (slug: string, label: string): CoverageEvidence => ({
  label,
  href: `/docs/${slug}`,
  sourcePath: `apps/web/content/docs/${slug}.md`,
});

const referenceTest = (file: string, label: string): CoverageEvidence => ({
  label,
  href: `https://github.com/vana-com/pdpp/blob/main/reference-implementation/test/${file}`,
  sourcePath: `reference-implementation/test/${file}`,
});

const referenceSource = (file: string, label: string): CoverageEvidence => ({
  label,
  href: `https://github.com/vana-com/pdpp/blob/main/reference-implementation/${file}`,
  sourcePath: `reference-implementation/${file}`,
});

const webRoute = (routePath: string, sourcePath: string, label: string): CoverageEvidence => ({
  label,
  href: routePath,
  sourcePath,
});

export const coverageRows = [
  {
    concept: "Grant request, consent, token issue, and revocation",
    category: "Protocol flow",
    specified: "yes",
    documented: "yes",
    implemented: "yes",
    tested: "yes",
    demonstrated: "partial",
    status: "implemented",
    evidence: [
      docs("spec-core", "Core protocol"),
      referenceTest("pdpp.test.js", "Reference end-to-end tests"),
      webRoute(
        "/docs/reference-implementation-examples",
        "apps/web/content/docs/reference-implementation-examples.md",
        "Examples"
      ),
    ],
    notes:
      "Runnable in the reference stack; public demonstration is currently explanatory rather than a live hosted flow.",
  },
  {
    concept: "Grant-scoped stream and record query enforcement",
    category: "Protocol flow",
    specified: "yes",
    documented: "yes",
    implemented: "yes",
    tested: "yes",
    demonstrated: "partial",
    status: "implemented",
    evidence: [
      docs("spec-data-query-api", "Data Query API"),
      referenceTest("query-contract.test.js", "Query contract tests"),
      referenceTest("event-spine.test.js", "Trace-backed enforcement tests"),
    ],
    notes: "Reference behavior covers stream lists, record reads, projection, rejection, and trace evidence.",
  },
  {
    concept: "Owner self-export and owner-token reads",
    category: "Protocol flow",
    specified: "yes",
    documented: "yes",
    implemented: "yes",
    tested: "yes",
    demonstrated: "partial",
    status: "implemented",
    evidence: [
      docs("spec-core", "Owner access model"),
      referenceTest("pdpp.test.js", "Owner export tests"),
      referenceSource("cli/commands/owner.js", "Owner CLI"),
    ],
    notes: "Owner access is modeled separately from third-party grant access.",
  },
  {
    concept: "Provider discovery and protected-resource metadata",
    category: "Protocol flow",
    specified: "yes",
    documented: "yes",
    implemented: "yes",
    tested: "yes",
    demonstrated: "no",
    status: "implemented",
    evidence: [
      docs("spec-auth-design", "Auth design"),
      referenceTest("provider-metadata.test.js", "Provider metadata tests"),
      referenceSource("server/metadata.ts", "Metadata source"),
    ],
    notes: "Discovery is implemented for local/self-hosted instances; no public hosted instance is promised.",
  },
  {
    concept: "Lexical retrieval at /v1/search",
    category: "Retrieval extension",
    specified: "yes",
    documented: "yes",
    implemented: "yes",
    tested: "yes",
    demonstrated: "partial",
    status: "implemented",
    evidence: [
      docs("spec-lexical-retrieval-extension", "Lexical retrieval extension"),
      referenceTest("lexical-retrieval.test.js", "Lexical retrieval tests"),
      webRoute("/sandbox/search", "apps/site/src/app/sandbox/search/page.tsx", "Mock search diagnostics"),
    ],
    notes:
      "Sandbox evidence demonstrates the interaction shape; operator-facing live diagnostics remain in the console.",
  },
  {
    concept: "Semantic retrieval at /v1/search/semantic",
    category: "Retrieval extension",
    specified: "yes",
    documented: "yes",
    implemented: "partial",
    tested: "yes",
    demonstrated: "partial",
    status: "partial",
    evidence: [
      docs("spec-semantic-retrieval-extension", "Semantic retrieval extension"),
      referenceTest("semantic-retrieval.test.js", "Semantic retrieval tests"),
      referenceDocs("reference-implementation", "Reference implementation notes"),
    ],
    notes: "The extension is intentionally experimental; coverage is honest about index and connector-field limits.",
  },
  {
    concept: "Collection manifest, connector run, STATE checkpoint, and runtime requirements",
    category: "Collection profile",
    specified: "yes",
    documented: "yes",
    implemented: "yes",
    tested: "yes",
    demonstrated: "partial",
    status: "implemented",
    evidence: [
      docs("spec-collection-profile", "Collection Profile"),
      referenceTest("collection-profile.test.js", "Collection profile tests"),
      referenceTest("scheduler.test.js", "Scheduler tests"),
    ],
    notes: "Reference connectors exercise seeded, native, and polyfill-backed collection paths.",
  },
  {
    concept: "Native source binding and connector identity",
    category: "Collection profile",
    specified: "yes",
    documented: "yes",
    implemented: "yes",
    tested: "yes",
    demonstrated: "partial",
    status: "implemented",
    evidence: [
      docs("spec-core", "Source binding"),
      referenceTest("query-contract.test.js", "Source-binding query tests"),
      referenceSource("manifests/spotify.json", "Reference connector manifest"),
    ],
    notes: "Reference tests cover binding-aware enforcement and connector-visible source identity.",
  },
  {
    concept: "Reference traces, grant timelines, and run timelines",
    category: "Reference control plane",
    specified: "not-applicable",
    documented: "yes",
    implemented: "yes",
    tested: "yes",
    demonstrated: "partial",
    status: "reference-only",
    evidence: [
      referenceDocs("reference-implementation", "Reference implementation docs"),
      referenceTest("event-spine.test.js", "Event spine tests"),
      webRoute("/sandbox/traces", "apps/site/src/app/sandbox/traces/page.tsx", "Trace sandbox"),
    ],
    notes: "Reference-only diagnostics explain this implementation; they do not extend the protocol contract.",
  },
  {
    concept: "Reference records, runs, and deployment diagnostics dashboard",
    category: "Reference control plane",
    specified: "not-applicable",
    documented: "yes",
    implemented: "yes",
    tested: "yes",
    demonstrated: "partial",
    status: "reference-only",
    evidence: [
      referenceTest("control-plane.test.js", "Control-plane tests"),
      referenceTest("deployment-diagnostics.test.js", "Deployment diagnostics tests"),
      webRoute("/sandbox/deployment", "apps/site/src/app/sandbox/deployment/page.tsx", "Deployment sandbox"),
    ],
    notes:
      "Public links point to sandbox diagnostics; live/operator diagnostics are intentionally outside public protocol docs.",
  },
  {
    concept: "Mock sandbox protocol walkthroughs",
    category: "Sandbox",
    specified: "not-applicable",
    documented: "yes",
    implemented: "yes",
    tested: "yes",
    demonstrated: "yes",
    status: "implemented",
    evidence: [
      webRoute(
        "/sandbox/walkthrough",
        "apps/web/src/app/sandbox/walkthrough/page.tsx",
        "Functional sandbox walkthrough"
      ),
      {
        label: "Sandbox state reducer tests",
        href: "https://github.com/vana-com/pdpp/blob/main/apps/web/src/app/sandbox/walkthrough/state.test.ts",
        sourcePath: "apps/web/src/app/sandbox/walkthrough/state.test.ts",
      },
    ],
    notes:
      "End-to-end mock walkthrough covers request, owner consent, scoped query, revocation, and post-revocation refusal using deterministic fixtures and browser-local state.",
  },
  {
    concept: "Mock reference demo instance (dashboard-shaped)",
    category: "Sandbox",
    specified: "not-applicable",
    documented: "yes",
    implemented: "yes",
    tested: "yes",
    demonstrated: "yes",
    status: "implemented",
    evidence: [
      webRoute("/sandbox", "apps/web/src/app/sandbox/page.tsx", "Demo overview"),
      webRoute("/sandbox/records", "apps/web/src/app/sandbox/records/page.tsx", "Records browser"),
      webRoute("/sandbox/grants", "apps/web/src/app/sandbox/grants/page.tsx", "Grants list"),
      webRoute("/sandbox/runs", "apps/web/src/app/sandbox/runs/page.tsx", "Runs list"),
      webRoute("/sandbox/traces", "apps/web/src/app/sandbox/traces/page.tsx", "Traces list"),
      webRoute("/sandbox/deployment", "apps/web/src/app/sandbox/deployment/page.tsx", "Deployment / capabilities"),
      {
        label: "Demo dataset and builder tests",
        href: "https://github.com/vana-com/pdpp/blob/main/apps/web/src/app/sandbox/_demo",
        sourcePath: "apps/web/src/app/sandbox/_demo",
      },
    ],
    notes:
      "Dashboard-shaped surface backed by deterministic fictional data: connectors, streams, records, grants (issued/revoked/denied), runs (succeeded/failed/needs_input), traces, and deployment metadata. No live AS/RS, no credentials, no owner-token mint.",
  },
  {
    concept: "Mock callable demo APIs (sandbox-prefixed)",
    category: "Sandbox",
    specified: "not-applicable",
    documented: "yes",
    implemented: "yes",
    tested: "yes",
    demonstrated: "yes",
    status: "implemented",
    evidence: [
      webRoute("/sandbox/v1/schema", "apps/web/src/app/sandbox/v1/schema/route.ts", "GET /sandbox/v1/schema"),
      webRoute("/sandbox/v1/streams", "apps/web/src/app/sandbox/v1/streams/route.ts", "GET /sandbox/v1/streams"),
      webRoute(
        "/sandbox/v1/streams/pay_statements/records",
        "apps/web/src/app/sandbox/v1/streams/[stream]/records/route.ts",
        "GET /sandbox/v1/streams/:stream/records"
      ),
      webRoute("/sandbox/v1/search?q=payroll", "apps/web/src/app/sandbox/v1/search/route.ts", "GET /sandbox/v1/search"),
      webRoute(
        "/sandbox/_ref/grants/grant_sb_quill_paystmt/timeline",
        "apps/web/src/app/sandbox/ref/grants/[grantId]/timeline/route.ts",
        "GET /sandbox/_ref/grants/:id/timeline"
      ),
      webRoute(
        "/sandbox/.well-known/oauth-authorization-server",
        "apps/web/src/app/sandbox/well-known/oauth-authorization-server/route.ts",
        "GET /sandbox/.well-known/oauth-authorization-server"
      ),
      webRoute("/sandbox/api-examples", "apps/web/src/app/sandbox/api-examples/page.tsx", "Copyable API examples"),
      {
        label: "Route handler and builder tests",
        href: "https://github.com/vana-com/pdpp/blob/main/apps/web/src/app/sandbox/_demo/routes.test.ts",
        sourcePath: "apps/web/src/app/sandbox/_demo/routes.test.ts",
      },
    ],
    notes:
      "Sandbox-prefixed JSON APIs share builders with the demo UI so the rendered surface and HTTP responses cannot drift. Each response carries an `x-pdpp-demo: 1` header and an `is_demo: true` field.",
  },
  {
    concept: "Semantic subset grants and predicate-in-grant",
    category: "Deferred scope",
    specified: "partial",
    documented: "yes",
    implemented: "no",
    tested: "not-applicable",
    demonstrated: "not-applicable",
    status: "deferred",
    evidence: [docs("spec-deferred", "Deferred scope")],
    notes: "Intentionally excluded from v0.1 to avoid unreviewable consent predicates.",
  },
  {
    concept: "Source writeback and event-driven collection triggers",
    category: "Deferred scope",
    specified: "partial",
    documented: "yes",
    implemented: "no",
    tested: "not-applicable",
    demonstrated: "not-applicable",
    status: "deferred",
    evidence: [docs("spec-deferred", "Deferred source lifecycle and webhooks")],
    notes: "Future profiles may add these capabilities without changing current read-oriented grants.",
  },
  {
    concept: "Standardized cross-connector view names",
    category: "Deferred scope",
    specified: "partial",
    documented: "yes",
    implemented: "no",
    tested: "not-applicable",
    demonstrated: "not-applicable",
    status: "deferred",
    evidence: [docs("spec-deferred", "Deferred standardized views")],
    notes: "Current manifests may define views, but portable cross-connector view semantics are not standardized.",
  },
] as const satisfies readonly CoverageRow[];

export const coverageSummary = {
  total: coverageRows.length,
  implemented: coverageRows.filter((row) => row.implemented === "yes").length,
  partial: coverageRows.filter((row) => row.status === "partial").length,
  deferred: coverageRows.filter((row) => row.status === "deferred").length,
  planned: coverageRows.filter((row) => (row.status as CoverageStatus) === "planned").length,
} as const;

function validateCoverageRows(rows: readonly CoverageRow[]): void {
  const errors: string[] = [];

  for (const row of rows) {
    const requiresEvidence = row.implemented !== "no" || row.tested === "yes" || row.demonstrated === "yes";
    if (requiresEvidence && row.evidence.length === 0) {
      errors.push(`${row.concept}: marked as covered but has no evidence links`);
    }

    for (const evidence of row.evidence) {
      if (!(evidence.href && evidence.label && evidence.sourcePath)) {
        errors.push(`${row.concept}: evidence entries must include label, href, and sourcePath`);
        continue;
      }

      if (!existsSync(rootRelative(evidence.sourcePath))) {
        errors.push(`${row.concept}: evidence path does not exist: ${evidence.sourcePath}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid reference coverage matrix:\n${errors.join("\n")}`);
  }
}

// Disk-path validation runs at module load to catch evidence drift during
// dev and `next build`. In a deployed standalone build the referenced source
// files are stripped from the trace, so we soft-fail rather than crash a live
// page — the build has already enforced the invariant.
try {
  validateCoverageRows(coverageRows);
} catch (err) {
  if (process.env.NODE_ENV !== "production") {
    throw err;
  }
}
