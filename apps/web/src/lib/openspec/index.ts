import {
  changeArtifactPath,
  changeSpecDeltaPath,
  fileExistsAt,
  listChangeNames,
  listChangeSpecCapabilities,
  listSpecCapabilities,
  readArtifactIfExists,
  resolveRepoRoot,
  specPathFor,
  toPosix,
} from './filesystem';
import { countTasks, extractExcerpt, extractTitle, humanizeName } from './parse';
import type {
  OpenSpecArtifact,
  OpenSpecArtifactKind,
  OpenSpecChangeDetail,
  OpenSpecChangeStatus,
  OpenSpecChangeSummary,
  OpenSpecLandingSummary,
  OpenSpecSpecDetail,
  OpenSpecSpecSummary,
} from './types';

const STATUS_LINE_RE = /^\*\*Status:\*\*\s*(.+?)\s*$/im;

function deriveStatus(
  taskCounts: { completed: number; total: number },
): OpenSpecChangeStatus {
  if (taskCounts.total === 0) return 'unknown';
  if (taskCounts.completed >= taskCounts.total) return 'complete';
  return 'in-progress';
}

function pickLatest(...values: Array<string | null>): string | null {
  let latest: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (!latest || v > latest) latest = v;
  }
  return latest;
}

function extractStatusLabel(markdown: string | null): string | null {
  if (!markdown) return null;
  const match = STATUS_LINE_RE.exec(markdown);
  return match ? match[1] : null;
}

async function loadChangeSummary(
  repoRoot: string,
  changeName: string,
): Promise<OpenSpecChangeSummary | null> {
  const [proposal, design, tasks] = await Promise.all([
    readArtifactIfExists(repoRoot, changeArtifactPath(changeName, 'proposal.md')),
    readArtifactIfExists(repoRoot, changeArtifactPath(changeName, 'design.md')),
    readArtifactIfExists(repoRoot, changeArtifactPath(changeName, 'tasks.md')),
  ]);

  // A directory under changes/ with no official artifacts is not a real change.
  if (!proposal && !design && !tasks) return null;

  const affectedCapabilities = await listChangeSpecCapabilities(repoRoot, changeName);
  const taskCounts = tasks ? countTasks(tasks.markdown) : { completed: 0, total: 0 };

  const fallbackTitle = humanizeName(changeName);
  const title = proposal
    ? extractTitle(proposal.markdown, fallbackTitle)
    : design
      ? extractTitle(design.markdown, fallbackTitle)
      : fallbackTitle;

  const excerpt = proposal ? extractExcerpt(proposal.markdown) : null;
  const statusLabel = extractStatusLabel(proposal?.markdown ?? null);

  return {
    name: changeName,
    title,
    status: deriveStatus(taskCounts),
    statusLabel,
    completedTasks: taskCounts.completed,
    totalTasks: taskCounts.total,
    lastModified: pickLatest(
      proposal?.lastModified ?? null,
      design?.lastModified ?? null,
      tasks?.lastModified ?? null,
    ),
    excerpt,
    affectedCapabilities,
    hasProposal: Boolean(proposal),
    hasDesign: Boolean(design),
    hasTasks: Boolean(tasks),
    hasSpecDeltas: affectedCapabilities.length > 0,
  };
}

const STATUS_ORDER: Record<OpenSpecChangeStatus, number> = {
  'in-progress': 0,
  complete: 1,
  unknown: 2,
};

function sortChangeSummaries(rows: OpenSpecChangeSummary[]): OpenSpecChangeSummary[] {
  return [...rows].sort((a, b) => {
    const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (so !== 0) return so;
    const am = a.lastModified ?? '';
    const bm = b.lastModified ?? '';
    if (am !== bm) return am < bm ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

async function loadSpecSummary(
  repoRoot: string,
  capability: string,
  relatedByCapability: Map<string, string[]>,
): Promise<OpenSpecSpecSummary | null> {
  const raw = await readArtifactIfExists(repoRoot, specPathFor(capability));
  if (!raw) return null;
  return {
    capability,
    title: extractTitle(raw.markdown, humanizeName(capability)),
    excerpt: extractExcerpt(raw.markdown),
    repoRelativePath: raw.repoRelativePath,
    lastModified: raw.lastModified,
    relatedChanges: (relatedByCapability.get(capability) ?? []).slice().sort(),
  };
}

async function buildRelatedChangesMap(
  repoRoot: string,
  changeNames: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  await Promise.all(
    changeNames.map(async (changeName) => {
      const caps = await listChangeSpecCapabilities(repoRoot, changeName);
      for (const cap of caps) {
        const list = map.get(cap) ?? [];
        list.push(changeName);
        map.set(cap, list);
      }
    }),
  );
  return map;
}

export async function listOpenSpecChanges(): Promise<OpenSpecChangeSummary[]> {
  const repoRoot = await resolveRepoRoot();
  const names = await listChangeNames(repoRoot);
  const summaries = await Promise.all(names.map((name) => loadChangeSummary(repoRoot, name)));
  return sortChangeSummaries(summaries.filter((s): s is OpenSpecChangeSummary => s !== null));
}

export async function listOpenSpecSpecs(): Promise<OpenSpecSpecSummary[]> {
  const repoRoot = await resolveRepoRoot();
  const [capabilities, changeNames] = await Promise.all([
    listSpecCapabilities(repoRoot),
    listChangeNames(repoRoot),
  ]);
  const related = await buildRelatedChangesMap(repoRoot, changeNames);
  const summaries = await Promise.all(
    capabilities.map((cap) => loadSpecSummary(repoRoot, cap, related)),
  );
  return summaries
    .filter((s): s is OpenSpecSpecSummary => s !== null)
    .sort((a, b) => a.capability.localeCompare(b.capability));
}

export async function getOpenSpecLandingSummary(): Promise<OpenSpecLandingSummary> {
  const [changes, specs] = await Promise.all([listOpenSpecChanges(), listOpenSpecSpecs()]);
  return { changes, specs };
}

export async function getOpenSpecChange(
  changeName: string,
): Promise<OpenSpecChangeDetail | null> {
  const repoRoot = await resolveRepoRoot();
  const summary = await loadChangeSummary(repoRoot, changeName);
  if (!summary) return null;

  const [proposal, design] = await Promise.all([
    readArtifactIfExists(repoRoot, changeArtifactPath(changeName, 'proposal.md')),
    readArtifactIfExists(repoRoot, changeArtifactPath(changeName, 'design.md')),
  ]);

  return {
    ...summary,
    proposalExcerpt: proposal ? extractExcerpt(proposal.markdown) : null,
    designExcerpt: design ? extractExcerpt(design.markdown) : null,
  };
}

const KIND_TO_FILENAME: Record<Exclude<OpenSpecArtifactKind, 'spec'>, 'proposal.md' | 'design.md' | 'tasks.md'> = {
  proposal: 'proposal.md',
  design: 'design.md',
  tasks: 'tasks.md',
};

const KIND_TO_LABEL: Record<OpenSpecArtifactKind, string> = {
  proposal: 'Proposal',
  design: 'Design',
  tasks: 'Tasks',
  spec: 'Spec Delta',
};

export function openSpecArtifactLabel(kind: OpenSpecArtifactKind): string {
  return KIND_TO_LABEL[kind];
}

export async function getOpenSpecChangeArtifact(
  changeName: string,
  kind: Exclude<OpenSpecArtifactKind, 'spec'>,
): Promise<OpenSpecArtifact | null> {
  const repoRoot = await resolveRepoRoot();
  const filename = KIND_TO_FILENAME[kind];
  const raw = await readArtifactIfExists(repoRoot, changeArtifactPath(changeName, filename));
  if (!raw) return null;
  return {
    kind,
    title: extractTitle(raw.markdown, humanizeName(changeName)),
    markdown: raw.markdown,
    excerpt: extractExcerpt(raw.markdown),
    repoRelativePath: raw.repoRelativePath,
    absolutePath: raw.absolutePath,
    lastModified: raw.lastModified,
  };
}

export async function listOpenSpecChangeSpecDeltas(
  changeName: string,
): Promise<OpenSpecSpecSummary[]> {
  const repoRoot = await resolveRepoRoot();
  const changeExists = await fileExistsAt(
    repoRoot,
    changeArtifactPath(changeName, 'proposal.md'),
  );
  if (!changeExists) {
    // Still allow specs/ to exist if proposal is missing; only return empty if change dir absent.
    const allChanges = await listChangeNames(repoRoot);
    if (!allChanges.includes(changeName)) return [];
  }
  const capabilities = await listChangeSpecCapabilities(repoRoot, changeName);
  const summaries = await Promise.all(
    capabilities.map(async (capability) => {
      const raw = await readArtifactIfExists(
        repoRoot,
        changeSpecDeltaPath(changeName, capability),
      );
      if (!raw) return null;
      const summary: OpenSpecSpecSummary = {
        capability,
        title: extractTitle(raw.markdown, humanizeName(capability)),
        excerpt: extractExcerpt(raw.markdown),
        repoRelativePath: raw.repoRelativePath,
        lastModified: raw.lastModified,
        relatedChanges: [changeName],
      };
      return summary;
    }),
  );
  return summaries
    .filter((s): s is OpenSpecSpecSummary => s !== null)
    .sort((a, b) => a.capability.localeCompare(b.capability));
}

export async function getOpenSpecChangeSpecDelta(
  changeName: string,
  capability: string,
): Promise<OpenSpecArtifact | null> {
  const repoRoot = await resolveRepoRoot();
  const raw = await readArtifactIfExists(
    repoRoot,
    changeSpecDeltaPath(changeName, capability),
  );
  if (!raw) return null;
  return {
    kind: 'spec',
    title: extractTitle(raw.markdown, humanizeName(capability)),
    markdown: raw.markdown,
    excerpt: extractExcerpt(raw.markdown),
    repoRelativePath: raw.repoRelativePath,
    absolutePath: raw.absolutePath,
    lastModified: raw.lastModified,
  };
}

export async function getOpenSpecSpec(
  capability: string,
): Promise<OpenSpecSpecDetail | null> {
  const repoRoot = await resolveRepoRoot();
  const raw = await readArtifactIfExists(repoRoot, specPathFor(capability));
  if (!raw) return null;
  const changeNames = await listChangeNames(repoRoot);
  const related = await buildRelatedChangesMap(repoRoot, changeNames);
  return {
    capability,
    title: extractTitle(raw.markdown, humanizeName(capability)),
    excerpt: extractExcerpt(raw.markdown),
    repoRelativePath: raw.repoRelativePath,
    lastModified: raw.lastModified,
    relatedChanges: (related.get(capability) ?? []).slice().sort(),
    markdown: raw.markdown,
  };
}

export const REPO_RELATIVE_OPENSPEC_DIR = 'openspec';

export async function repoRelativeFromAbsolute(absolutePath: string): Promise<string> {
  const repoRoot = await resolveRepoRoot();
  const rel = absolutePath.startsWith(repoRoot)
    ? absolutePath.slice(repoRoot.length).replace(/^[\\/]+/, '')
    : absolutePath;
  return toPosix(rel);
}

export type {
  OpenSpecArtifact,
  OpenSpecArtifactKind,
  OpenSpecChangeDetail,
  OpenSpecChangeStatus,
  OpenSpecChangeSummary,
  OpenSpecLandingSummary,
  OpenSpecSpecDetail,
  OpenSpecSpecSummary,
} from './types';
