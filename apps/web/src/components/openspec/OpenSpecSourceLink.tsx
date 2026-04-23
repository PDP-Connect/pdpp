import { formatOpenSpecDate } from '@/lib/openspec/format';

const GITHUB_BLOB_BASE = 'https://github.com/vana-com/pdpp/blob/main';
const GITHUB_TREE_BASE = 'https://github.com/vana-com/pdpp/tree/main';

export function openSpecGithubUrl(repoRelativePath: string): string {
  const normalizedPath = repoRelativePath.replace(/\/+$/, '');
  const base = repoRelativePath.endsWith('/') ? GITHUB_TREE_BASE : GITHUB_BLOB_BASE;
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
  const created = formatOpenSpecDate(createdAt ?? null);
  const updated = formatOpenSpecDate(lastModified ?? null);
  const showUpdated = updated && updated !== created;

  return (
    <div className="pdpp-caption flex flex-wrap items-center gap-2 text-muted-foreground">
      {created && (
        <>
          <span>Created {created}</span>
          <span aria-hidden="true" className="opacity-40">
            ·
          </span>
        </>
      )}
      {showUpdated && (
        <>
          <span>Updated {updated}</span>
          <span aria-hidden="true" className="opacity-40">
            ·
          </span>
        </>
      )}
      <span className="font-mono break-all">{repoRelativePath}</span>
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
