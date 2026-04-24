import { Timestamp } from "@/components/ui/timestamp.tsx";

const GITHUB_BLOB_BASE = "https://github.com/vana-com/pdpp/blob/main";
const GITHUB_TREE_BASE = "https://github.com/vana-com/pdpp/tree/main";
const TRAILING_SLASH_RE = /\/+$/;

export function openSpecGithubUrl(repoRelativePath: string): string {
  const normalizedPath = repoRelativePath.replace(TRAILING_SLASH_RE, "");
  const base = repoRelativePath.endsWith("/") ? GITHUB_TREE_BASE : GITHUB_BLOB_BASE;
  return `${base}/${normalizedPath}`;
}

export function OpenSpecSourceLink({
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
            Created <Timestamp value={createdAt} precision="date" />
          </span>
          <span aria-hidden="true" className="opacity-40">
            ·
          </span>
        </>
      )}
      {showUpdated && (
        <>
          <span className="inline-flex items-baseline gap-1">
            Updated <Timestamp value={lastModified} precision="date" />
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
        href={openSpecGithubUrl(repoRelativePath)}
        target="_blank"
        rel="noreferrer"
        className="transition-colors hover:text-foreground"
      >
        View on GitHub →
      </a>
    </div>
  );
}
