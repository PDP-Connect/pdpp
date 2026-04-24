export type OpenSpecArtifactKind = "proposal" | "design" | "tasks" | "spec";

export type OpenSpecArtifact = {
  kind: OpenSpecArtifactKind;
  title: string;
  markdown: string;
  excerpt: string | null;
  repoRelativePath: string;
  absolutePath: string;
  createdAt: string | null;
  lastModified: string | null;
};

export type OpenSpecSpecSummary = {
  capability: string;
  title: string;
  excerpt: string | null;
  repoRelativePath: string;
  createdAt: string | null;
  lastModified: string | null;
  relatedChanges: string[];
};

export type OpenSpecSpecDetail = OpenSpecSpecSummary & {
  markdown: string;
};

export type OpenSpecChangeArtifactSummary = {
  kind: OpenSpecArtifactKind;
  present: boolean;
  repoRelativePath: string | null;
};

export type OpenSpecChangeStatus = "in-progress" | "complete" | "unknown";

export type OpenSpecChangeSummary = {
  name: string;
  title: string;
  status: OpenSpecChangeStatus;
  statusLabel: string | null;
  completedTasks: number;
  totalTasks: number;
  createdAt: string | null;
  lastModified: string | null;
  excerpt: string | null;
  affectedCapabilities: string[];
  hasProposal: boolean;
  hasDesign: boolean;
  hasTasks: boolean;
  hasSpecDeltas: boolean;
};

export type OpenSpecChangeDetail = OpenSpecChangeSummary & {
  proposalExcerpt: string | null;
  designExcerpt: string | null;
};

export type OpenSpecDesignNoteKind =
  | "open-question"
  | "plan"
  | "audit"
  | "research"
  | "strategy"
  | "connector-note"
  | "working-note";

export type OpenSpecDesignNoteSummary = {
  changeName: string;
  noteSlug: string;
  noteKind: OpenSpecDesignNoteKind;
  noteKindLabel: string;
  title: string;
  excerpt: string | null;
  repoRelativePath: string;
  createdAt: string | null;
  lastModified: string | null;
};

export type OpenSpecDesignNoteDetail = OpenSpecDesignNoteSummary & {
  markdown: string;
};

export type OpenSpecDesignNoteGroup = {
  changeName: string;
  changeTitle: string;
  noteCount: number;
  createdAt: string | null;
  lastModified: string | null;
  countsByKind: Partial<Record<OpenSpecDesignNoteKind, number>>;
  notes: OpenSpecDesignNoteSummary[];
};

export type OpenSpecLandingSummary = {
  changes: OpenSpecChangeSummary[];
  specs: OpenSpecSpecSummary[];
  designNotes: OpenSpecDesignNoteSummary[];
};
