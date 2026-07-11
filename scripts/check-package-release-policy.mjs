#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = process.cwd();
const expectedPublishConfig = {
  access: 'public',
  provenance: false,
  registry: 'https://registry.npmjs.org/',
  tag: 'latest',
};
const expectedRepositoryUrl = 'git+https://github.com/vana-com/pdpp.git';
const expectedNodeEngine = '>=22.14.0';

// The release train publishes a single channel: 0.x versions on npm's default
// `latest` dist-tag, released from `main` (see docs/reference/package-release-policy.md).
// The `beta` dist-tag is retired; operator-facing install/exec instructions
// reference publishable packages by plain name (or a pinned version). We forbid
// the retired `@beta` tag on every publishable-package install command in the
// active docs below, so the docs cannot silently regress operators onto the
// dead prerelease channel.
const retiredDistTag = 'beta';
const installDocRoots = [
  'README.md',
  'docs',
  'reference-implementation/README.md',
  'reference-implementation/docs',
  'apps/site/content/docs',
  'packages/cli/README.md',
  'packages/local-collector/README.md',
  'packages/mcp-server/README.md',
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function listMarkdownFiles(relativeRoot) {
  const absolute = path.join(repoRoot, relativeRoot);
  if (!existsSync(absolute)) {
    return [];
  }
  const out = [];
  function walk(target) {
    const stat = statSync(target);
    if (stat.isFile()) {
      if (target.endsWith('.md')) {
        out.push(path.relative(repoRoot, target));
      }
      return;
    }
    if (!stat.isDirectory()) {
      return;
    }
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') {
        continue;
      }
      walk(path.join(target, entry.name));
    }
  }
  walk(absolute);
  return out;
}

// Returns one error string per active-doc install command that references a
// publishable package with the retired `@beta` dist-tag. Pure over its inputs
// so it can be unit tested without touching the registry.
export function findRetiredTagInstallDocReferences({ packageNames, docFiles, readFile }) {
  const problems = [];
  // Match `npm i`, `npm install`, `npm add`, `pnpm add`, `pnpm install`,
  // `pnpm dlx`, `pnpm exec`, and `npx` invocations only — prose mentions of a
  // package name (specs, comments) are intentionally ignored.
  const installCommand = /\b(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|install|dlx|exec)|npx)\b/;
  for (const docFile of docFiles) {
    const lines = readFile(docFile).split('\n');
    for (const line of lines) {
      // Skip shell comments and Markdown headings (`# ...`): they describe an
      // install command in prose but cannot execute one, so a bare package
      // name there is not an operator hazard.
      if (/^\s*#/.test(line)) {
        continue;
      }
      if (!installCommand.test(line)) {
        continue;
      }
      for (const packageName of packageNames) {
        // Plain references and pinned versions (`@1.2.3`, `@0.1.0`) are fine;
        // only the retired `beta` dist-tag is forbidden.
        const retiredReference = new RegExp(`${escapeRegExp(packageName)}@${retiredDistTag}(?![\\w.-])`);
        if (retiredReference.test(line)) {
          problems.push(
            `${docFile} installs ${packageName} with the retired @${retiredDistTag} dist-tag (the release train publishes only to latest): ${line.trim()}`,
          );
        }
      }
    }
  }
  return problems;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listPackageJsonFiles(rootDir = '.') {
  const root = path.join(repoRoot, rootDir);
  const out = [];
  const ignoredDirs = new Set(['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules']);
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          walk(fullPath);
        }
        continue;
      }
      if (entry.name === 'package.json') {
        out.push(path.relative(repoRoot, fullPath));
      }
    }
  }
  walk(root);
  return out.sort();
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fail(errors, message) {
  errors.push(message);
}

export function findPublishableWorkspaceDependencyErrors(publishablePackages) {
  const problems = [];
  for (const { file, manifest } of publishablePackages) {
    for (const [section, dependencies] of Object.entries({
      dependencies: manifest.dependencies,
      optionalDependencies: manifest.optionalDependencies,
      peerDependencies: manifest.peerDependencies,
    })) {
      if (!dependencies || typeof dependencies !== 'object') {
        continue;
      }
      for (const [name, range] of Object.entries(dependencies)) {
        if (typeof range === 'string' && range.startsWith('workspace:')) {
          problems.push(
            `${file} ${section}.${name} uses ${range}; publishable packages must use registry-resolvable ranges`,
          );
        }
      }
    }
  }
  return problems;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

const errors = [];
const rootPackage = readJson(path.join(repoRoot, 'package.json'));
if (rootPackage.private !== true) {
  fail(errors, 'root package.json must remain private:true so the workspace root cannot publish');
}

const packageFiles = listPackageJsonFiles();
const packages = packageFiles.map((file) => ({
  file,
  dir: path.dirname(file),
  manifest: readJson(path.join(repoRoot, file)),
}));
const publishablePackages = packages
  .filter(({ dir, manifest }) => dir.startsWith('packages/') && manifest.name?.startsWith('@pdpp/') && manifest.private !== true)
  .sort((a, b) => a.dir.localeCompare(b.dir));

for (const { file, manifest } of packages) {
  if (file === 'package.json') {
    continue;
  }
  const hasPublishConfig = manifest.publishConfig !== undefined;
  const isPublishablePdppPackage = publishablePackages.some((pkg) => pkg.file === file);
  if (!isPublishablePdppPackage && manifest.private !== true) {
    fail(errors, `${file} must be private:true unless it is explicitly listed as a publishable @pdpp package`);
  }
  if (!isPublishablePdppPackage && hasPublishConfig) {
    fail(errors, `${file} is not publishable but declares publishConfig`);
  }
}

for (const { file, dir, manifest } of publishablePackages) {
  if (!deepEqual(manifest.publishConfig, expectedPublishConfig)) {
    fail(errors, `${file} publishConfig must match ${JSON.stringify(expectedPublishConfig)}`);
  }
  if (manifest.version !== '0.0.0') {
    fail(errors, `${file} version must stay at 0.0.0; semantic-release owns published versions`);
  }
  if (!manifest.description) {
    fail(errors, `${file} must declare a package description`);
  }
  if (!manifest.license) {
    fail(errors, `${file} must declare a license`);
  }
  if (!manifest.files || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail(errors, `${file} must use an explicit files allowlist`);
  }
  if (!manifest.scripts?.verify) {
    fail(errors, `${file} must expose scripts.verify for release quality checks`);
  }
  if (manifest.repository?.url !== expectedRepositoryUrl || manifest.repository?.directory !== dir) {
    fail(errors, `${file} repository must point to ${expectedRepositoryUrl} and directory ${dir}`);
  }
  if (manifest.engines?.node !== expectedNodeEngine) {
    fail(errors, `${file} engines.node must be ${expectedNodeEngine}`);
  }
  if (!existsSync(path.join(repoRoot, dir, 'README.md'))) {
    fail(errors, `${dir}/README.md must exist for the npm package`);
  }
}

for (const problem of findPublishableWorkspaceDependencyErrors(publishablePackages)) {
  fail(errors, problem);
}

const releaseConfig = readFileSync(path.join(repoRoot, '.releaserc.yaml'), 'utf8');
const releaseWorkflow = readFileSync(path.join(repoRoot, '.github/workflows/semantic-release.yml'), 'utf8');
const configuredPackageRoots = [...releaseConfig.matchAll(/pkgRoot:\s*"([^"]+)"/g)].map((match) => match[1]).sort();
const publishableRoots = publishablePackages.map(({ dir }) => dir).sort();

if (!deepEqual(configuredPackageRoots, publishableRoots)) {
  fail(
    errors,
    `.releaserc.yaml @semantic-release/npm pkgRoot list ${JSON.stringify(configuredPackageRoots)} must match publishable packages ${JSON.stringify(publishableRoots)}`,
  );
}

if (!/id-token:\s*write/.test(releaseWorkflow)) {
  fail(errors, '.github/workflows/semantic-release.yml must grant id-token: write for npm trusted publishing');
}
if (/\b(NPM_TOKEN|NODE_AUTH_TOKEN)\b/.test(releaseWorkflow)) {
  fail(errors, 'semantic-release workflow must not use NPM_TOKEN/NODE_AUTH_TOKEN in the normal release path');
}
if (!/pnpm release:policy-check/.test(releaseWorkflow)) {
  fail(errors, 'semantic-release quality job must run pnpm release:policy-check');
}

// Single release channel: releases are cut from `main` onto npm's default
// `latest` dist-tag. A prerelease branch (the old `beta` lane) is a second
// moving part that goes stale; the policy forbids reintroducing one.
if (/^\s*prerelease\s*:/m.test(releaseConfig) || /^\s*-\s*name:\s*beta\s*$/m.test(releaseConfig)) {
  fail(errors, '.releaserc.yaml must declare a single release channel from main (no prerelease/beta branch)');
}
if (!/branches:\s*\[main\]/.test(releaseWorkflow)) {
  fail(errors, 'semantic-release workflow must trigger on push to main (single release channel)');
}

const packageScopes = publishablePackages.map(({ manifest }) => manifest.name.replace(/^@pdpp\//, ''));
for (const scope of packageScopes) {
  if (!new RegExp(`scope:\\s*${scope}\\b`).test(releaseConfig)) {
    fail(errors, `.releaserc.yaml release-notes grouping must include Conventional Commit scope "${scope}"`);
  }
}

const publishablePackageNames = publishablePackages.map(({ manifest }) => manifest.name);
for (const packageName of publishablePackageNames) {
  const verifyCommand = new RegExp(`pnpm\\s+--filter\\s+${escapeRegExp(packageName)}\\s+run\\s+verify`);
  if (!verifyCommand.test(releaseWorkflow)) {
    fail(errors, `.github/workflows/semantic-release.yml quality job must verify ${packageName} before publishing`);
  }
}

const installDocFiles = installDocRoots.flatMap((root) => listMarkdownFiles(root));
const retiredTagInstallDocReferences = findRetiredTagInstallDocReferences({
  packageNames: publishablePackageNames,
  docFiles: installDocFiles,
  readFile: (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8'),
});
for (const problem of retiredTagInstallDocReferences) {
  fail(errors, problem);
}

// Exported so a unit test can assert the live repository passes without
// re-running the CLI side effects.
export const policyErrors = errors;

if (isMainModule) {
  if (errors.length > 0) {
    console.error('PDPP package release policy check failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `PDPP package release policy OK: ${publishablePackages.map(({ manifest }) => manifest.name).join(', ') || 'no publishable packages'}`,
  );
}
