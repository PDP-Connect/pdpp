import { formatOpenSpecDate } from '@/lib/openspec/format';

const GITHUB_BASE = 'https://github.com/vana-com/pdpp/blob/main';

export function openSpecGithubUrl(repoRelativePath: string): string {
  return `${GITHUB_BASE}/${repoRelativePath}`;
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
      {updated && (
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
