const METADATA_LINE_RE = /^\*\*[^*]+:\*\*/;

export function humanizeName(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function extractTitle(markdown: string, fallback: string): string {
  const lines = markdown.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("# ") && !line.startsWith("## ")) {
      return line.slice(2).trim() || fallback;
    }
  }
  return fallback;
}

function stripMarkdownInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isListBlock(lines: string[]): boolean {
  return lines.length > 0 && lines.every((line) => /^\s*(?:[-*+]|\d+\.)\s+/.test(line));
}

export function extractExcerpt(markdown: string): string | null {
  const lines = markdown.split("\n");
  let i = 0;

  while (i < lines.length && (lines[i] ?? "").trim() === "") {
    i++;
  }
  if (i < lines.length && (lines[i] ?? "").trim().startsWith("# ")) {
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() === "") {
      i++;
    }
  }

  while (i < lines.length) {
    const current = lines[i] ?? "";
    const trimmed = current.trim();

    if (trimmed === "") {
      i++;
      continue;
    }

    if (METADATA_LINE_RE.test(trimmed)) {
      i++;
      continue;
    }

    if (trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "") {
      paragraph.push((lines[i] ?? "").trim());
      i++;
    }

    if (isListBlock(paragraph)) {
      continue;
    }

    const joined = stripMarkdownInline(paragraph.join(" "));
    if (joined) {
      return joined;
    }
  }

  return null;
}

export function stripLeadingDocumentTitle(markdown: string): string {
  const lines = markdown.split("\n");
  let i = 0;

  while (i < lines.length && (lines[i] ?? "").trim() === "") {
    i++;
  }
  if (i < lines.length && (lines[i] ?? "").trim().startsWith("# ")) {
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() === "") {
      i++;
    }
    return lines.slice(i).join("\n");
  }

  return markdown;
}

export type TaskCounts = { completed: number; total: number };

export function countTasks(markdown: string): TaskCounts {
  let completed = 0;
  let total = 0;
  const lines = markdown.split("\n");
  for (const raw of lines) {
    const line = raw.trimStart();
    if (line.startsWith("- [x]") || line.startsWith("- [X]")) {
      completed++;
      total++;
    } else if (line.startsWith("- [ ]")) {
      total++;
    }
  }
  return { completed, total };
}
