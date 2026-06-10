const METADATA_LINE_RE = /^\*\*[^*]+:\*\*/;
const SLUG_SEPARATOR_RE = /[-_]/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+/;

export function humanizeName(slug: string): string {
  return slug
    .split(SLUG_SEPARATOR_RE)
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
  return lines.length > 0 && lines.every((line) => LIST_ITEM_RE.test(line));
}

function skipBlankLines(lines: string[], from: number): number {
  let i = from;
  while (i < lines.length && (lines[i] ?? "").trim() === "") {
    i++;
  }
  return i;
}

function skipLeadingTitle(lines: string[], from: number): number {
  let i = skipBlankLines(lines, from);
  if (i < lines.length && (lines[i] ?? "").trim().startsWith("# ")) {
    i = skipBlankLines(lines, i + 1);
  }
  return i;
}

function isSkippableExcerptLine(trimmed: string): boolean {
  return trimmed === "" || trimmed.startsWith("#") || METADATA_LINE_RE.test(trimmed);
}

function readParagraph(lines: string[], from: number): { paragraph: string[]; next: number } {
  const paragraph: string[] = [];
  let i = from;
  while (i < lines.length && (lines[i] ?? "").trim() !== "") {
    paragraph.push((lines[i] ?? "").trim());
    i++;
  }
  return { paragraph, next: i };
}

export function extractExcerpt(markdown: string): string | null {
  const lines = markdown.split("\n");
  let i = skipLeadingTitle(lines, 0);

  while (i < lines.length) {
    const trimmed = (lines[i] ?? "").trim();
    if (isSkippableExcerptLine(trimmed)) {
      i++;
      continue;
    }

    const { paragraph, next } = readParagraph(lines, i);
    i = next;
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
  const firstNonBlank = skipBlankLines(lines, 0);
  if (firstNonBlank < lines.length && (lines[firstNonBlank] ?? "").trim().startsWith("# ")) {
    const afterTitle = skipBlankLines(lines, firstNonBlank + 1);
    return lines.slice(afterTitle).join("\n");
  }
  return markdown;
}

export interface TaskCounts {
  completed: number;
  total: number;
}

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
