import {
  changeArtifactPath,
  changeDesignNotePath,
  changeSpecDeltaPath,
  fileExistsAt,
  listChangeDesignNoteFiles,
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
  OpenSpecDesignNoteDetail,
  OpenSpecDesignNoteSummary,
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
  for (const value of values) {
    if (!value) continue;
    if (!latest || value > latest) latest = value;
  }
  return latest;
}

function pickEarliest(...values: Array<string | null>): string | null {
  let earliest: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!earliest || value < earliest) earliest = value;
  }
  return earliest;
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

  if (!proposal && !design && !tasks) return null;

  const affectedCapabilities = await listChangeSpecCapabilities(repoRoot, changeName);
  const deltaArtifacts = await Promise.all(
    affectedCapabilities.map((capability) =>
      readArtifactIfExists(repoRoot, changeSpecDeltaPath(changeName, capability)),
    ),
  );

  const taskCounts = tasks ? countTasks(tasks.markdown) : { completed: 0, total: 0 };
  const fallbackTitle = humanizeName(changeName);
  const title = proposal
    ? extractTitle(proposal.markdown, fallbackTitle)
    : design
      ? extractTitle(design.markdown, fallbackTitle)
      : fallbackTitle;
  const excerpt = proposal ? extractExcerpt(proposal.markdown) : null;
  const statusLabel = extractStatusLabel(proposal?.markdown ?? null);
  const timestampSources = [proposal, design, tasks, ...deltaArtifacts].filter(Boolean);

  return {
    name: changeName,
    title,
    status: deriveStatus(taskCounts),
    statusLabel,
    completedTasks: taskCounts.completed,
    totalTasks: taskCounts.total,
    createdAt: pickEarliest(...timestampSources.map((artifact) => artifact?.createdAt ?? null)),
    lastModified: pickLatest(
      ...timestampSources.map((artifact) => artifact?.lastModified ?? null),
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
    const statusOrder = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusOrder !== 0) return statusOrder;
    const aModified = a.lastModified ?? '';
    const bModified = b.lastModified ?? '';
    if (aModified !== bModified) return aModified < bModified ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

async function buildRelatedChangesMap(
  repoRoot: string,
  changeNames: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  await Promise.all(
    changeNames.map(async (changeName) => {
      const capabilities = await listChangeSpecCapabilities(repoRoot, changeName);
      for (const capability of capabilities) {
        const list = map.get(capability) ?? [];
        list.push(changeName);
        map.set(capability, list);
      }
    }),
  );
  return map;
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
    createdAt: raw.createdAt,
    lastModified: raw.lastModified,
    relatedChanges: (relatedByCapability.get(capability) ?? []).slice().sort(),
  };
}

function noteSlugFromFilename(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

async function loadDesignNoteSummary(
  repoRoot: string,
  changeName: string,
  noteFilename: string,
): Promise<OpenSpecDesignNoteSummary | null> {
  const raw = await readArtifactIfExists(
    repoRoot,
    changeDesignNotePath(changeName, noteFilename),
  );
  if (!raw) return null;

  const noteSlug = noteSlugFromFilename(noteFilename);

  return {
    changeName,
    noteSlug,
    title: extractTitle(raw.markdown, humanizeName(noteSlug)),
    excerpt: extractExcerpt(raw.markdown),
    repoRelativePath: raw.repoRelativePath,
    createdAt: raw.createdAt,
    lastModified: raw.lastModified,
  };
}

function sortDesignNotes(rows: OpenSpecDesignNoteSummary[]): OpenSpecDesignNoteSummary[] {
  return [...rows].sort((a, b) => {
    const aModified = a.lastModified ?? '';
    const bModified = b.lastModified ?? '';
    if (aModified !== bModified) return aModified < bModified ? 1 : -1;
    const aCreated = a.createdAt ?? '';
    const bCreated = b.createdAt ?? '';
    if (aCreated !== bCreated) return aCreated < bCreated ? 1 : -1;
    const changeOrder = a.changeName.localeCompare(b.changeName);
    if (changeOrder !== 0) return changeOrder;
    return a.noteSlug.localeCompare(b.noteSlug);
  });
}

export async function listOpenSpecChanges(): Promise<OpenSpecChangeSummary[]> {
  const repoRoot = await resolveRepoRoot();
  const changeNames = await listChangeNames(repoRoot);
  const summaries = await Promise.all(
    changeNames.map((changeName) => loadChangeSummary(repoRoot, changeName)),
  );
  return sortChangeSummaries(
    summaries.filter((summary): summary is OpenSpecChangeSummary => summary !== null),
  );
}

export async function listOpenSpecSpecs(): Promise<OpenSpecSpecSummary[]> {
  const repoRoot = await resolveRepoRoot();
  const [capabilities, changeNames] = await Promise.all([
    listSpecCapabilities(repoRoot),
    listChangeNames(repoRoot),
  ]);
  const related = await buildRelatedChangesMap(repoRoot, changeNames);
  const summaries = await Promise.all(
    capabilities.map((capability) => loadSpecSummary(repoRoot, capability, related)),
  );
  return summaries
    .filter((summary): summary is OpenSpecSpecSummary => summary !== null)
    .sort((a, b) => a.capability.localeCompare(b.capability));
}

export async function listOpenSpecDesignNotes(): Promise<OpenSpecDesignNoteSummary[]> {
  const repoRoot = await resolveRepoRoot();
  const changeNames = await listChangeNames(repoRoot);
  const noteGroups = await Promise.all(
    changeNames.map(async (changeName) => {
      const files = await listChangeDesignNoteFiles(repoRoot, changeName);
      const summaries = await Promise.all(
        files.map((file) => loadDesignNoteSummary(repoRoot, changeName, file)),
      );
      return summaries.filter(
        (summary): summary is OpenSpecDesignNoteSummary => summary !== null,
      );
    }),
  );

  return sortDesignNotes(noteGroups.flat());
}

export async function getOpenSpecLandingSummary(): Promise<OpenSpecLandingSummary> {
  const [changes, specs, designNotes] = await Promise.all([
    listOpenSpecChanges(),
    listOpenSpecSpecs(),
    listOpenSpecDesignNotes(),
  ]);
  return { changes, specs, designNotes };
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

const KIND_TO_FILENAME: Record<
  Exclude<OpenSpecArtifactKind, 'spec'>,
  'proposal.md' | 'design.md' | 'tasks.md'
> = {
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
  const raw = await readArtifactIfExists(
    repoRoot,
    changeArtifactPath(changeName, KIND_TO_FILENAME[kind]),
  );
  if (!raw) return null;

  return {
    kind,
    title: extractTitle(raw.markdown, humanizeName(changeName)),
    markdown: raw.markdown,
    excerpt: extractExcerpt(raw.markdown),
    repoRelativePath: raw.repoRelativePath,
    absolutePath: raw.absolutePath,
    createdAt: raw.createdAt,
    lastModified: raw.lastModified,
  };
}

export async function listOpenSpecChangeSpecDeltas(
  changeName: string,
): Promise<OpenSpecSpecSummary[]> {
  const repoRoot = await resolveRepoRoot();
  const changeExists = await fileExistsAt(repoRoot, changeArtifactPath(changeName, 'proposal.md'));
  if (!changeExists) {
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
      return {
        capability,
        title: extractTitle(raw.markdown, humanizeName(capability)),
        excerpt: extractExcerpt(raw.markdown),
        repoRelativePath: raw.repoRelativePath,
        createdAt: raw.createdAt,
        lastModified: raw.lastModified,
        relatedChanges: [changeName],
      } satisfies OpenSpecSpecSummary;
    }),
  );

  return summaries
    .filter((summary): summary is OpenSpecSpecSummary => summary !== null)
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
    createdAt: raw.createdAt,
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
    createdAt: raw.createdAt,
    lastModified: raw.lastModified,
    relatedChanges: (related.get(capability) ?? []).slice().sort(),
    markdown: raw.markdown,
  };
}

export async function getOpenSpecDesignNote(
  changeName: string,
  noteSlug: string,
): Promise<OpenSpecDesignNoteDetail | null> {
  const repoRoot = await resolveRepoRoot();
  const raw = await readArtifactIfExists(
    repoRoot,
    changeDesignNotePath(changeName, `${noteSlug}.md`),
  );
  if (!raw) return null;

  return {
    changeName,
    noteSlug,
    title: extractTitle(raw.markdown, humanizeName(noteSlug)),
    excerpt: extractExcerpt(raw.markdown),
    repoRelativePath: raw.repoRelativePath,
    createdAt: raw.createdAt,
    lastModified: raw.lastModified,
    markdown: raw.markdown,
  };
}

export const REPO_RELATIVE_OPENSPEC_DIR = 'openspec';

export async function repoRelativeFromAbsolute(absolutePath: string): Promise<string> {
  const repoRoot = await resolveRepoRoot();
  const relativePath = absolutePath.startsWith(repoRoot)
    ? absolutePath.slice(repoRoot.length).replace(/^[\\/]+/, '')
    : absolutePath;
  return toPosix(relativePath);
}

export type {
  OpenSpecArtifact,
  OpenSpecArtifactKind,
  OpenSpecChangeDetail,
  OpenSpecChangeStatus,
  OpenSpecChangeSummary,
  OpenSpecDesignNoteDetail,
  OpenSpecDesignNoteSummary,
  OpenSpecLandingSummary,
  OpenSpecSpecDetail,
  OpenSpecSpecSummary,
} from './types';
