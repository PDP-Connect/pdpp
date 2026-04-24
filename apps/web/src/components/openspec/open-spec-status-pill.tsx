import type { OpenSpecChangeStatus } from "@/lib/openspec/types.ts";

const LABELS: Record<OpenSpecChangeStatus, string> = {
  "in-progress": "In progress",
  complete: "Complete",
  unknown: "No tasks",
};

const TONES: Record<OpenSpecChangeStatus, string> = {
  complete: "text-foreground",
  "in-progress": "text-foreground",
  unknown: "text-muted-foreground",
};

export function OpenSpecStatusPill({ status }: { status: OpenSpecChangeStatus }) {
  const label = LABELS[status];
  const tone = TONES[status];

  return <span className={`pdpp-caption ${tone}`}>{label}</span>;
}
