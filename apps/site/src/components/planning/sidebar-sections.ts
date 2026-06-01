import type { DocsSidebarSection } from "@/components/docs/docs-sidebar.tsx";
import { PLANNING_LABEL, planningPath } from "@/lib/openspec/public.ts";

export type PlanningSidebarScope =
  | { kind: "overview" }
  | { kind: "specs"; capability?: string }
  | { kind: "notes"; changeName?: string; noteSlug?: string }
  | {
      kind: "change";
      changeName: string;
      artifact?: "overview" | "proposal" | "design" | "tasks" | "spec-deltas";
    };

export function buildPlanningSidebarSections(scope: PlanningSidebarScope): DocsSidebarSection[] {
  const top: DocsSidebarSection = {
    heading: PLANNING_LABEL,
    items: [
      { href: planningPath(), label: "Overview", active: scope.kind === "overview" },
      { href: planningPath("/changes"), label: "Changes", active: scope.kind === "change" },
      { href: planningPath("/specs"), label: "Specs", active: scope.kind === "specs" },
      { href: planningPath("/notes"), label: "Notes", active: scope.kind === "notes" },
    ],
  };

  if (scope.kind !== "change") {
    return [top];
  }

  const base = planningPath(`/changes/${scope.changeName}`);
  const changeSection: DocsSidebarSection = {
    heading: scope.changeName,
    items: [
      { href: base, label: "Overview", active: scope.artifact === "overview" },
      {
        href: `${base}/proposal`,
        label: "Proposal",
        active: scope.artifact === "proposal",
      },
      { href: `${base}/design`, label: "Design", active: scope.artifact === "design" },
      { href: `${base}/tasks`, label: "Tasks", active: scope.artifact === "tasks" },
      {
        href: `${base}/specs`,
        label: "Spec Deltas",
        active: scope.artifact === "spec-deltas",
      },
    ],
  };

  return [top, changeSection];
}
