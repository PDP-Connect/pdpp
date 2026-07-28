import { execFileSync, spawnSync } from "node:child_process";

const recognizedExtensions = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".gql",
  ".graphql",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);

const authoredExamples = [
  "packages/reference-contract/src/validate.ts",
  "packages/reference-contract/test/validate-response.test.ts",
  "packages/polyfill-connectors/src/connector-runtime.ts",
  "packages/polyfill-connectors/connectors/apple_health/__fixtures__/record-step-count.ts",
  "reference-implementation/test/fixtures/device-ingest-failstop-server.mjs",
  "apps/console/public/pdpp-dashboard-sw.js",
  "scripts/spec-check.ts",
  "deploy/railway/core-supervisor.ts",
  "docker/neko/policies.json",
];

const excludedExamples = [
  "packages/polyfill-connectors/fixtures/claude_code/scrubbed/pilot-real-shape/records/messages.jsonl",
  "packages/polyfill-connectors/connectors/heb/__fixtures__/sign-in-page.html",
  "packages/polyfill-connectors/connectors/twitter_archive/__fixtures__/archive-files/data/tweets.js",
  "reference-implementation/test/fixtures/amazon-browser-collector-proof-records.json",
  "reference-implementation/docs/generated/reference-routes.md",
  "reference-implementation/openapi/reference-full.openapi.json",
  "packages/local-collector/dist/local-collector/src/runner.js",
  "reports/biome-report.json",
  "node_modules/ultracite/package.json",
];

const processedFilesPattern = /Files processed:\s*\n([\s\S]*?)(?=\n[^\n]*Files fixed:|\nScanned project)/;
const processedFileLinePattern = /^\s*-\s+(.+)$/gm;
const excludedPath =
  /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.source|coverage|reports?)(\/|$)|(^|\/)docs\/generated(\/|$)|^reference-implementation\/openapi\/.*\.json$|(^|\/)test\/fixtures\/[^/]+\.json$|(^|\/)fixtures\/.*\.(json|html|csv|md|log|dat)$|(^|\/)__fixtures__\/.*\.(html|json|csv)$|(^|\/)connectors\/twitter_archive\/__fixtures__\/archive-files\/.*\.js$|(^|\/)(generated|__generated__)(\/|$)|\.(auto|gen|generated)\.[^/]+$|(^|\/)(schema|schema\.graphql)\.d\.ts$|(^|\/)next-env\.d\.ts$|(^|\/)(package-lock\.json|yarn\.lock|bun\.lock|pnpm-lock\.yaml)$|\.(snap|har|jsonl)$/;

function workspaceRoots(): string[] {
  const result = spawnSync("pnpm", ["list", "--recursive", "--depth=-1", "--json"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Workspace discovery failed with exit code ${result.status}: ${result.stderr}`);
  }

  let workspaces: unknown;
  try {
    workspaces = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Workspace discovery returned invalid JSON: ${(error as Error).message}`, { cause: error });
  }
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error("Workspace discovery returned no workspaces");
  }

  const cwd = process.cwd();
  return [
    ...new Set(
      (workspaces as { path: unknown }[]).map(({ path }) => {
        if (path === cwd) {
          return ".";
        }
        if (typeof path !== "string" || !path.startsWith(`${cwd}/`)) {
          throw new Error(`Workspace path is outside the checkout: ${path}`);
        }
        return path.slice(cwd.length + 1);
      })
    ),
  ];
}

function processedFiles(command: string, args: string[]): Set<string> {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const output = `${result.stdout}\n${result.stderr}`;
  const match = output.match(processedFilesPattern);
  if (!match) {
    throw new Error(`Could not read the processed-file list from ${command} ${args.join(" ")}`);
  }

  const files = [...(match[1] ?? "").matchAll(processedFileLinePattern)].map((entry) => (entry[1] ?? "").trim());
  if (result.error) {
    throw result.error;
  }
  return new Set(files);
}

function sorted(set: Set<string>): string[] {
  return [...set].sort();
}

const biomeFiles = new Set<string>();
const ultraciteFiles = new Set<string>();
const roots = workspaceRoots();

for (const root of roots) {
  const biome = processedFiles("pnpm", ["exec", "biome", "check", "--verbose", "--max-diagnostics=1", root]);
  const ultracite = processedFiles("pnpm", ["exec", "ultracite", "check", "--verbose", "--max-diagnostics=1", root]);
  const biomeOnly = sorted(new Set([...biome].filter((file) => !ultracite.has(file))));
  const ultraciteOnly = sorted(new Set([...ultracite].filter((file) => !biome.has(file))));
  if (biomeOnly.length || ultraciteOnly.length) {
    throw new Error(
      `${root}: Biome/Ultracite selection differs\nBiome only: ${biomeOnly.join(", ")}\nUltracite only: ${ultraciteOnly.join(", ")}`
    );
  }
  for (const file of biome) {
    biomeFiles.add(file);
  }
  for (const file of ultracite) {
    ultraciteFiles.add(file);
  }
}

const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean));
for (const file of authoredExamples) {
  if (!tracked.has(file)) {
    throw new Error(`Authored example is not tracked: ${file}`);
  }
  if (!biomeFiles.has(file)) {
    throw new Error(`Authored example was not selected: ${file}`);
  }
}

for (const file of excludedExamples) {
  if (biomeFiles.has(file) || ultraciteFiles.has(file)) {
    throw new Error(`Excluded artifact was selected: ${file}`);
  }
  if (!excludedPath.test(file)) {
    throw new Error(`Excluded example does not match the contract: ${file}`);
  }
}

for (const file of biomeFiles) {
  if (excludedPath.test(file)) {
    throw new Error(`Selected file violates the exclusion contract: ${file}`);
  }
}

const trackedRecognized = [...tracked].filter((file) => recognizedExtensions.has(file.slice(file.lastIndexOf("."))));
const uncovered = trackedRecognized.filter((file) => !(biomeFiles.has(file) || excludedPath.test(file)));
if (uncovered.length) {
  throw new Error(`Tracked recognized files are neither selected nor narrowly excluded:\n${uncovered.join("\n")}`);
}

const selectedTracked = trackedRecognized.filter((file) => biomeFiles.has(file));
const excludedTracked = trackedRecognized.filter((file) => !biomeFiles.has(file));

console.log(`Biome and Ultracite selected the same ${biomeFiles.size} files across ${roots.length} workspace roots.`);
console.log(`Authored source included: ${authoredExamples.join(", ")}`);
console.log(
  `Tracked recognized coverage: ${selectedTracked.length} selected, ${excludedTracked.length} narrowly excluded.`
);
console.log(
  "Executable fixture/runtime code remains selected; dependency/build/data/generated/report exclusions are path- or extension-specific."
);
