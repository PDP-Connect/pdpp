// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The concept renders a specific set of lead-bold paragraphs as a highlighted
// `<aside class="note">` callout (spec.html: "Design axiom:", "Note:", "Note on
// ...:") while every other lead-bold paragraph ("Token resolution:", "Tombstones:",
// etc.) stays a plain paragraph — this was an authorial choice in the concept's
// hand-written HTML, not a rule derivable from "starts with bold + colon" alone.
// The root spec-*.md files are the single normative source (see
// scripts/sync-spec-docs.mjs) and stay plain Markdown for GitHub/llms.txt
// rendering, so this matches the same two lead terms at MDX-compile time rather
// than hand-marking the source with JSX.
const NOTE_LEAD_PATTERN = /^(Design axiom|Note\b.*):$/;

interface TextNode {
  type: "text";
  value: string;
}

interface StrongNode {
  children?: Array<{ type?: string; value?: string }>;
  type: "strong";
}

interface ParagraphNode {
  children?: Array<{ type?: string; value?: string; children?: unknown[] }>;
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  type: "paragraph";
}

interface TreeNode {
  children?: TreeNode[];
  type?: string;
}

function leadTermOf(node: ParagraphNode): string | null {
  const first = node.children?.[0] as StrongNode | undefined;

  if (first?.type !== "strong") {
    return null;
  }

  const label = first.children?.[0] as TextNode | undefined;

  if (label?.type !== "text" || typeof label.value !== "string") {
    return null;
  }

  return label.value;
}

function isNoteParagraph(node: ParagraphNode): boolean {
  const term = leadTermOf(node);
  return term !== null && NOTE_LEAD_PATTERN.test(term);
}

export function remarkNoteAsides() {
  return (tree: TreeNode) => {
    for (const node of tree.children ?? []) {
      if (node.type === "paragraph" && isNoteParagraph(node as ParagraphNode)) {
        const paragraph = node as ParagraphNode;
        paragraph.data ??= {};
        paragraph.data.hName = "aside";
        paragraph.data.hProperties = {
          ...(paragraph.data.hProperties ?? {}),
          className: "pdpp-note",
        };
      }
    }
  };
}
