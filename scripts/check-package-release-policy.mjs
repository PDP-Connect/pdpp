#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const expectedPublishConfig = {
  access: 'public',
  provenance: false,
  registry: 'https://registry.npmjs.org/',
  tag: 'beta',
};
const expectedRepositoryUrl = 'git+https://github.com/vana-com/pdpp.git';
const expectedNodeEngine = '>=22.14.0';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
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

for (const { file, dir, manifest } of packages) {
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

const packageScopes = publishablePackages.map(({ manifest }) => manifest.name.replace(/^@pdpp\//, ''));
for (const scope of packageScopes) {
  if (!new RegExp(`scope:\\s*${scope}\\b`).test(releaseConfig)) {
    fail(errors, `.releaserc.yaml release-notes grouping must include Conventional Commit scope "${scope}"`);
  }
}

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
