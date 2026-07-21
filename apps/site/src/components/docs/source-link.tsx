import { Timestamp } from "@/components/ui/timestamp.tsx";

const GITHUB_BLOB_BASE = "https://github.com/PDP-Connect/pdpp/blob/main";
const GITHUB_TREE_BASE = "https://github.com/PDP-Connect/pdpp/tree/main";
const TRAILING_SLASH_RE = /\/+$/;

export function repoGithubUrl(repoRelativePath: string): string {
  const normalizedPath = repoRelativePath.replace(TRAILING_SLASH_RE, "");
  const base = repoRelativePath.endsWith("/") ? GITHUB_TREE_BASE : GITHUB_BLOB_BASE;
  return `${base}/${normalizedPath}`;
}

export function SourceLink({
  repoRelativePath,
  createdAt,
  lastModified,
}: {
  repoRelativePath: string;
  createdAt?: string | null;
  lastModified?: string | null;
}) {
  const showUpdated = Boolean(
    lastModified && createdAt && new Date(lastModified).getTime() !== new Date(createdAt).getTime()
  );

  return (
    <div className="pdpp-caption flex flex-wrap items-center gap-2 text-muted-foreground">
      {createdAt && (
        <>
          <span className="inline-flex items-baseline gap-1">
            Created <Timestamp precision="date" value={createdAt} valueKind="calendar-date" />
          </span>
          <span aria-hidden="true" className="opacity-40">
            ·
          </span>
        </>
      )}
      {showUpdated && (
        <>
          <span className="inline-flex items-baseline gap-1">
            Updated <Timestamp precision="date" value={lastModified} valueKind="calendar-date" />
          </span>
          <span aria-hidden="true" className="opacity-40">
            ·
          </span>
        </>
      )}
      <span className="break-all font-mono">{repoRelativePath}</span>
      <span aria-hidden="true" className="opacity-40">
        ·
      </span>
      <a
        className="transition-colors hover:text-foreground"
        href={repoGithubUrl(repoRelativePath)}
        rel="noreferrer"
        target="_blank"
      >
        View on GitHub →
      </a>
    </div>
  );
}
