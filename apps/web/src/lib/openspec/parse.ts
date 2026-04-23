const METADATA_LINE_RE = /^\*\*[A-Za-z][\w \-/]*:\*\*/;

export function humanizeName(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function extractTitle(markdown: string, fallback: string): string {
  const lines = markdown.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      return line.slice(2).trim() || fallback;
    }
  }
  return fallback;
}

export function extractExcerpt(markdown: string): string | null {
  const lines = markdown.split('\n');
  let i = 0;

  // Skip leading blank lines, H1, and any contiguous metadata block (e.g. **Status:**, **Owner:**).
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && lines[i].trim().startsWith('# ')) {
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') {
      i++;
      continue;
    }

    // Skip pure metadata lines (single-line bold-key definitions).
    if (METADATA_LINE_RE.test(trimmed)) {
      i++;
      continue;
    }

    // Skip subheadings — find a real paragraph.
    if (trimmed.startsWith('#')) {
      i++;
      continue;
    }

    // Collect contiguous non-empty lines as one paragraph.
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      paragraph.push(lines[i].trim());
      i++;
    }
    const joined = paragraph.join(' ').trim();
    if (joined) return joined;
  }

  return null;
}

export type TaskCounts = { completed: number; total: number };

export function countTasks(markdown: string): TaskCounts {
  let completed = 0;
  let total = 0;
  const lines = markdown.split('\n');
  for (const raw of lines) {
    const line = raw.trimStart();
    if (line.startsWith('- [x]') || line.startsWith('- [X]')) {
      completed++;
      total++;
    } else if (line.startsWith('- [ ]')) {
      total++;
    }
  }
  return { completed, total };
}
