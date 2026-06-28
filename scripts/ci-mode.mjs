#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RULESET_NAME = 'main: require PR + reference-implementation check';
export const HOSTED_CONTEXT = 'typecheck + full test suite';
export const LOCAL_CONTEXT = 'signoff/reference-implementation';
export const MANAGED_WORKFLOW_PATHS = [
  '.github/workflows/reference-implementation.yml',
  '.github/workflows/react-doctor.yml',
  '.github/workflows/docker-images.yml',
  '.github/workflows/spec-check.yml',
  '.github/workflows/polyfill-connectors.yml',
  '.github/workflows/remote-surface.yml',
  '.github/workflows/semantic-release.yml',
];

const modeContexts = {
  hosted: [HOSTED_CONTEXT],
  local: [LOCAL_CONTEXT],
};

function usage() {
  return `Usage:
  node scripts/ci-mode.mjs status
  node scripts/ci-mode.mjs hosted
  node scripts/ci-mode.mjs local
  node scripts/ci-mode.mjs signoff [--sha <sha>] [--description <text>] [--target-url <url>] [--force]

Modes:
  hosted   Require the GitHub Actions check: ${HOSTED_CONTEXT}
  local    Require the local signoff status: ${LOCAL_CONTEXT}

The script updates only the repository ruleset required-status-check contexts
and the managed GitHub Actions workflow states. It preserves the existing
pull-request, deletion, and non-fast-forward rules.`;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    input: options.input,
  }).trim();
}

function runJson(command, args, options = {}) {
  const out = run(command, args, options);
  return out ? JSON.parse(out) : null;
}

function gh(args, options = {}) {
  return run('gh', args, options);
}

function ghJson(args, options = {}) {
  return runJson('gh', args, options);
}

function git(args) {
  return run('git', args);
}

export function getRequiredStatusContexts(ruleset) {
  const rule = ruleset.rules?.find((candidate) => candidate.type === 'required_status_checks');
  return rule?.parameters?.required_status_checks?.map((check) => check.context) ?? [];
}

export function detectCiMode(contexts) {
  const normalized = [...contexts].sort();
  for (const [mode, expected] of Object.entries(modeContexts)) {
    if (JSON.stringify(normalized) === JSON.stringify([...expected].sort())) {
      return mode;
    }
  }
  return 'custom';
}

export function rulesetWithRequiredStatusContexts(ruleset, contexts) {
  let replaced = false;
  const nextRules = (ruleset.rules ?? []).map((rule) => {
    if (rule.type !== 'required_status_checks') {
      return rule;
    }
    replaced = true;
    return {
      ...rule,
      parameters: {
        ...(rule.parameters ?? {}),
        required_status_checks: contexts.map((context) => ({ context })),
      },
    };
  });
  if (!replaced) {
    nextRules.push({
      type: 'required_status_checks',
      parameters: {
        do_not_enforce_on_create: false,
        required_status_checks: contexts.map((context) => ({ context })),
        strict_required_status_checks_policy: false,
      },
    });
  }
  return {
    bypass_actors: ruleset.bypass_actors ?? [],
    conditions: ruleset.conditions,
    enforcement: ruleset.enforcement,
    name: ruleset.name,
    rules: nextRules,
    target: ruleset.target,
  };
}

export function workflowUpdatesForMode(workflows, mode, managedPaths = MANAGED_WORKFLOW_PATHS) {
  if (mode !== 'hosted' && mode !== 'local') {
    throw new Error(`unknown mode: ${mode}`);
  }
  const workflowsByPath = new Map(workflows.map((workflow) => [workflow.path, workflow]));
  return managedPaths.map((path) => {
    const workflow = workflowsByPath.get(path) ?? null;
    const action = mode === 'hosted' ? 'enable' : 'disable';
    return {
      action,
      missing: workflow === null,
      needsChange: workflow ? (mode === 'hosted' ? workflow.state !== 'active' : workflow.state === 'active') : false,
      path,
      state: workflow?.state ?? 'missing',
      workflow,
    };
  });
}

function repoApiPath(suffix = '') {
  return `repos/:owner/:repo${suffix}`;
}

function getManagedWorkflowPaths(mode, workflows) {
  const configured = process.env.PDPP_CI_MANAGED_WORKFLOWS;
  let paths;
  if (configured) {
    paths = configured
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  } else if (mode === 'local') {
    paths = workflows.map((workflow) => workflow.path);
  } else {
    paths = MANAGED_WORKFLOW_PATHS;
  }
  return [...new Set(paths)];
}

function loadRuleset() {
  const configuredId = process.env.PDPP_CI_RULESET_ID;
  if (configuredId) {
    return ghJson(['api', repoApiPath(`/rulesets/${configuredId}`)]);
  }
  const name = process.env.PDPP_CI_RULESET_NAME || DEFAULT_RULESET_NAME;
  const rulesets = ghJson(['api', repoApiPath('/rulesets')]) ?? [];
  const summary = rulesets.find((ruleset) => ruleset.name === name);
  if (!summary) {
    throw new Error(`ruleset not found: ${name}`);
  }
  return ghJson(['api', repoApiPath(`/rulesets/${summary.id}`)]);
}

function writeRuleset(ruleset, contexts) {
  const body = JSON.stringify(rulesetWithRequiredStatusContexts(ruleset, contexts), null, 2);
  return ghJson(
    [
      'api',
      '--method',
      'PUT',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      repoApiPath(`/rulesets/${ruleset.id}`),
      '--input',
      '-',
    ],
    { input: body }
  );
}

function loadWorkflows() {
  const response = ghJson(['api', repoApiPath('/actions/workflows?per_page=100')]);
  return response?.workflows ?? [];
}

function applyManagedWorkflowMode(mode) {
  const workflows = loadWorkflows();
  const updates = workflowUpdatesForMode(workflows, mode, getManagedWorkflowPaths(mode, workflows));
  const missing = updates.filter((update) => update.missing);
  if (missing.length > 0) {
    throw new Error(`managed workflow not found: ${missing.map((update) => update.path).join(', ')}`);
  }
  const changed = updates.filter((update) => update.needsChange);
  for (const update of changed) {
    gh([
      'api',
      '--method',
      'PUT',
      repoApiPath(`/actions/workflows/${update.workflow.id}/${update.action}`),
    ]);
  }
  console.log(`managed workflows: ${mode === 'hosted' ? 'enabled' : 'disabled'} (${changed.length} changed)`);
  for (const update of updates) {
    const marker = update.needsChange ? update.action : 'unchanged';
    console.log(`- ${update.path}: ${update.state} -> ${marker}`);
  }
}

function printStatus() {
  const ruleset = loadRuleset();
  const contexts = getRequiredStatusContexts(ruleset);
  const mode = detectCiMode(contexts);
  console.log(`ruleset: ${ruleset.name} (#${ruleset.id})`);
  console.log(`mode: ${mode}`);
  console.log('required status checks:');
  for (const context of contexts) {
    console.log(`- ${context}`);
  }
  console.log('managed workflows:');
  const workflows = loadWorkflows();
  const statusMode = mode === 'custom' ? 'hosted' : mode;
  for (const update of workflowUpdatesForMode(workflows, statusMode, getManagedWorkflowPaths(statusMode, workflows))) {
    console.log(`- ${update.path}: ${update.state}`);
  }
}

function setMode(mode) {
  const contexts = modeContexts[mode];
  if (!contexts) {
    throw new Error(`unknown mode: ${mode}`);
  }
  if (mode === 'hosted') {
    applyManagedWorkflowMode(mode);
  }
  const before = loadRuleset();
  const previous = getRequiredStatusContexts(before);
  const after = writeRuleset(before, contexts);
  const current = getRequiredStatusContexts(after);
  if (mode === 'local') {
    applyManagedWorkflowMode(mode);
  }
  console.log(`mode: ${mode}`);
  console.log(`ruleset: ${after.name} (#${after.id})`);
  console.log(`previous required status checks: ${previous.join(', ') || '(none)'}`);
  console.log(`current required status checks: ${current.join(', ') || '(none)'}`);
}

function isCleanAndPushed() {
  if (git(['status', '--porcelain'])) {
    return false;
  }
  git(['rev-parse', '--abbrev-ref', '@{push}']);
  return git(['log', '@{push}..']) === '';
}

function parseSignoffArgs(args) {
  const out = {
    context: LOCAL_CONTEXT,
    description: 'Local reference-implementation gate signed off',
    force: false,
    sha: null,
    targetUrl: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--context') {
      out.context = args[++i];
    } else if (arg === '--description') {
      out.description = args[++i];
    } else if (arg === '--force') {
      out.force = true;
    } else if (arg === '--sha') {
      out.sha = args[++i];
    } else if (arg === '--target-url') {
      out.targetUrl = args[++i];
    } else {
      throw new Error(`unknown signoff option: ${arg}`);
    }
  }
  if (!out.context) {
    throw new Error('signoff context cannot be empty');
  }
  return out;
}

function signoff(args) {
  const options = parseSignoffArgs(args);
  if (!options.force && !isCleanAndPushed()) {
    throw new Error('repository has uncommitted or unpushed changes; rerun with --force only for an explicit override');
  }
  const sha = options.sha || git(['rev-parse', 'HEAD']);
  const body = {
    context: options.context,
    description: options.description,
    state: 'success',
  };
  if (options.targetUrl) {
    body.target_url = options.targetUrl;
  }
  ghJson(['api', '--method', 'POST', repoApiPath(`/statuses/${sha}`), '--input', '-'], {
    input: JSON.stringify(body),
  });
  console.log(`signed off ${sha} with ${options.context}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command === 'status') {
    printStatus();
    return;
  }
  if (command === 'hosted' || command === 'local') {
    setMode(command);
    return;
  }
  if (command === 'signoff') {
    signoff(args);
    return;
  }
  throw new Error(`unknown command: ${command}\n${usage()}`);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}
