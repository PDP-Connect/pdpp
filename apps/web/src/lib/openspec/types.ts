export type OpenSpecArtifactKind = "proposal" | "design" | "tasks" | "spec";

export interface OpenSpecArtifact {
  absolutePath: string;
  createdAt: string | null;
  excerpt: string | null;
  kind: OpenSpecArtifactKind;
  lastModified: string | null;
  markdown: string;
  repoRelativePath: string;
  title: string;
}

export interface OpenSpecSpecSummary {
  capability: string;
  createdAt: string | null;
  excerpt: string | null;
  lastModified: string | null;
  relatedChanges: string[];
  repoRelativePath: string;
  title: string;
}

export type OpenSpecSpecDetail = OpenSpecSpecSummary & {
  markdown: string;
};

export interface OpenSpecChangeArtifactSummary {
  kind: OpenSpecArtifactKind;
  present: boolean;
  repoRelativePath: string | null;
}

export type OpenSpecChangeStatus = "in-progress" | "complete" | "unknown";

export interface OpenSpecChangeSummary {
  affectedCapabilities: string[];
  completedTasks: number;
  createdAt: string | null;
  excerpt: string | null;
  hasDesign: boolean;
  hasProposal: boolean;
  hasSpecDeltas: boolean;
  hasTasks: boolean;
  lastModified: string | null;
  name: string;
  status: OpenSpecChangeStatus;
  statusLabel: string | null;
  title: string;
  totalTasks: number;
}

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

export interface OpenSpecDesignNoteSummary {
  changeName: string;
  createdAt: string | null;
  excerpt: string | null;
  lastModified: string | null;
  noteKind: OpenSpecDesignNoteKind;
  noteKindLabel: string;
  noteSlug: string;
  repoRelativePath: string;
  title: string;
}

export type OpenSpecDesignNoteDetail = OpenSpecDesignNoteSummary & {
  markdown: string;
};

export interface OpenSpecDesignNoteGroup {
  changeName: string;
  changeTitle: string;
  countsByKind: Partial<Record<OpenSpecDesignNoteKind, number>>;
  createdAt: string | null;
  lastModified: string | null;
  noteCount: number;
  notes: OpenSpecDesignNoteSummary[];
}

export interface OpenSpecLandingSummary {
  changes: OpenSpecChangeSummary[];
  designNotes: OpenSpecDesignNoteSummary[];
  specs: OpenSpecSpecSummary[];
}
