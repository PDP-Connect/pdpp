import Link from "next/link";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import type {
  OpenSpecDesignNoteGroup,
  OpenSpecDesignNoteKind,
  OpenSpecDesignNoteSummary,
} from "@/lib/openspec/index.ts";
import { planningPath } from "@/lib/openspec/public.ts";
import { OpenSpecArtifactCard } from "./OpenSpecArtifactCard.tsx";

const NOTE_KIND_LABELS: Record<OpenSpecDesignNoteKind, string> = {
  "open-question": "Open questions",
  plan: "Plans",
  strategy: "Strategy & framing",
  audit: "Audits & reviews",
  research: "Research",
  "connector-note": "Connector notes",
  "working-note": "Working notes",
};

const NOTE_KIND_SUMMARY_LABELS: Record<OpenSpecDesignNoteKind, { singular: string; plural: string }> = {
  "open-question": { singular: "open question", plural: "open questions" },
  plan: { singular: "plan", plural: "plans" },
  strategy: { singular: "strategy note", plural: "strategy notes" },
  audit: { singular: "audit", plural: "audits" },
  research: { singular: "research note", plural: "research notes" },
  "connector-note": { singular: "connector note", plural: "connector notes" },
  "working-note": { singular: "working note", plural: "working notes" },
};

const NOTE_KIND_ORDER: OpenSpecDesignNoteKind[] = [
  "open-question",
  "plan",
  "strategy",
  "audit",
  "research",
  "connector-note",
  "working-note",
];

function noteDates(note: OpenSpecDesignNoteSummary) {
  const created = note.createdAt;
  const updated = note.lastModified;
  const differ = created && updated && new Date(created).getTime() !== new Date(updated).getTime();

  if (differ) {
    return (
      <>
        <span className="inline-flex items-baseline gap-1">
          created <Timestamp value={created} precision="date" />
        </span>
        <span className="inline-flex items-baseline gap-1">
          updated <Timestamp value={updated} precision="date" />
        </span>
      </>
    );
  }

  if (created) {
    return (
      <span className="inline-flex items-baseline gap-1">
        created <Timestamp value={created} precision="date" />
      </span>
    );
  }
  if (updated) {
    return (
      <span className="inline-flex items-baseline gap-1">
        updated <Timestamp value={updated} precision="date" />
      </span>
    );
  }
  return null;
}

function describeGroup(group: OpenSpecDesignNoteGroup): string {
  const parts = NOTE_KIND_ORDER.flatMap((noteKind) => {
    const count = group.countsByKind[noteKind];
    if (!count) {
      return [];
    }
    const labels = NOTE_KIND_SUMMARY_LABELS[noteKind];
    return [`${count} ${count === 1 ? labels.singular : labels.plural}`];
  });

  return parts.join(" · ");
}

function groupNotesByKind(notes: OpenSpecDesignNoteSummary[]) {
  const grouped = new Map<OpenSpecDesignNoteKind, OpenSpecDesignNoteSummary[]>();

  for (const note of notes) {
    const list = grouped.get(note.noteKind) ?? [];
    list.push(note);
    grouped.set(note.noteKind, list);
  }

  return NOTE_KIND_ORDER.map((noteKind) => ({
    noteKind,
    label: NOTE_KIND_LABELS[noteKind],
    notes: grouped.get(noteKind) ?? [],
  })).filter((group) => group.notes.length > 0);
}

function GroupBody({ group }: { group: OpenSpecDesignNoteGroup }) {
  const sections = groupNotesByKind(group.notes);

  return (
    <div className="flex flex-col gap-6">
      {sections.map((section) => (
        <section key={`${group.changeName}-${section.noteKind}`} className="flex flex-col gap-2">
          <div className="pdpp-caption text-muted-foreground">{section.label}</div>
          <div className="flex flex-col divide-y divide-border/60">
            {section.notes.map((note) => (
              <OpenSpecArtifactCard
                key={`${note.changeName}/${note.noteSlug}`}
                href={planningPath(`/notes/${note.changeName}/${note.noteSlug}`)}
                title={note.title}
                excerpt={note.excerpt}
                footer={noteDates(note)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function OpenSpecNoteGroups({
  groups,
  collapsible = false,
  defaultOpenCount = 0,
  showChangeLink = false,
}: {
  groups: OpenSpecDesignNoteGroup[];
  collapsible?: boolean;
  defaultOpenCount?: number;
  showChangeLink?: boolean;
}) {
  return (
    <div className="flex flex-col gap-8">
      {groups.map((group, index) => {
        const summary = describeGroup(group);

        if (collapsible) {
          return (
            <details key={group.changeName} className="border-border/60 border-t pt-4" open={index < defaultOpenCount}>
              <summary className="flex cursor-pointer list-none items-start gap-4 [&::-webkit-details-marker]:hidden">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="pdpp-title text-foreground">{group.changeTitle}</div>
                  <div className="pdpp-body text-muted-foreground">
                    {group.noteCount} notes
                    {summary ? ` · ${summary}` : ""}
                    {group.lastModified ? (
                      <>
                        {" "}
                        · updated <Timestamp value={group.lastModified} precision="date" />
                      </>
                    ) : null}
                  </div>
                </div>
              </summary>
              <div className="mt-5">
                <GroupBody group={group} />
              </div>
            </details>
          );
        }

        return (
          <section key={group.changeName} className="flex flex-col gap-5 border-border/60 border-t pt-5">
            <header className="flex items-start gap-4">
              <div className="flex min-w-0 flex-col gap-1.5">
                <h2 className="pdpp-title text-foreground">{group.changeTitle}</h2>
                <p className="pdpp-body text-muted-foreground">
                  {group.noteCount} notes
                  {summary ? ` · ${summary}` : ""}
                  {group.lastModified ? (
                    <>
                      {" "}
                      · updated <Timestamp value={group.lastModified} precision="date" />
                    </>
                  ) : null}
                </p>
              </div>
              {showChangeLink && (
                <Link
                  href={planningPath(`/changes/${group.changeName}`)}
                  className="pdpp-caption ml-auto whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground"
                >
                  View change
                </Link>
              )}
            </header>
            <GroupBody group={group} />
          </section>
        );
      })}
    </div>
  );
}
