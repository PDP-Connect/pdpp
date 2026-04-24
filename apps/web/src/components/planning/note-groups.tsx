import Link from "next/link";
import { ArtifactLink } from "@/components/docs/artifact-link.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import type {
  OpenSpecDesignNoteGroup,
  OpenSpecDesignNoteKind,
  OpenSpecDesignNoteSummary,
} from "@/lib/openspec/index.ts";
import { planningPath } from "@/lib/openspec/public.ts";

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
          created <Timestamp precision="date" value={created} />
        </span>
        <span className="inline-flex items-baseline gap-1">
          updated <Timestamp precision="date" value={updated} />
        </span>
      </>
    );
  }

  if (created) {
    return (
      <span className="inline-flex items-baseline gap-1">
        created <Timestamp precision="date" value={created} />
      </span>
    );
  }
  if (updated) {
    return (
      <span className="inline-flex items-baseline gap-1">
        updated <Timestamp precision="date" value={updated} />
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
        <section className="flex flex-col gap-2" key={`${group.changeName}-${section.noteKind}`}>
          <div className="pdpp-caption text-muted-foreground">{section.label}</div>
          <div className="flex flex-col divide-y divide-border/60">
            {section.notes.map((note) => (
              <ArtifactLink
                excerpt={note.excerpt}
                footer={noteDates(note)}
                href={planningPath(`/notes/${note.changeName}/${note.noteSlug}`)}
                key={`${note.changeName}/${note.noteSlug}`}
                title={note.title}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function NoteGroups({
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
            <details className="border-border/60 border-t pt-4" key={group.changeName} open={index < defaultOpenCount}>
              <summary className="flex cursor-pointer list-none items-start gap-4 [&::-webkit-details-marker]:hidden">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="pdpp-title text-foreground">{group.changeTitle}</div>
                  <div className="pdpp-body text-muted-foreground">
                    {group.noteCount} notes
                    {summary ? ` · ${summary}` : ""}
                    {group.lastModified ? (
                      <>
                        {" "}
                        · updated <Timestamp precision="date" value={group.lastModified} />
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
          <section className="flex flex-col gap-5 border-border/60 border-t pt-5" key={group.changeName}>
            <header className="flex items-start gap-4">
              <div className="flex min-w-0 flex-col gap-1.5">
                <h2 className="pdpp-title text-foreground">{group.changeTitle}</h2>
                <p className="pdpp-body text-muted-foreground">
                  {group.noteCount} notes
                  {summary ? ` · ${summary}` : ""}
                  {group.lastModified ? (
                    <>
                      {" "}
                      · updated <Timestamp precision="date" value={group.lastModified} />
                    </>
                  ) : null}
                </p>
              </div>
              {showChangeLink && (
                <Link
                  className="pdpp-caption ml-auto whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground"
                  href={planningPath(`/changes/${group.changeName}`)}
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
