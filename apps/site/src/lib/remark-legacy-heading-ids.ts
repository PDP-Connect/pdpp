// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

interface HeadingNode {
  children?: Array<{ type?: string; value?: string }>;
  data?: {
    id?: string;
    hProperties?: Record<string, unknown>;
  };
  type: "heading";
}

interface TreeNode {
  children?: TreeNode[];
  data?: {
    id?: string;
    hProperties?: Record<string, unknown>;
  };
  type?: string;
  value?: string;
}

const LEGACY_ID_PATTERN = /\s*\{#([A-Za-z0-9_-]+)\}\s*$/;

function visit(node: TreeNode, visitor: (node: TreeNode) => void) {
  visitor(node);

  if (!node.children) {
    return;
  }

  for (const child of node.children) {
    visit(child, visitor);
  }
}

function applyLegacyId(node: HeadingNode) {
  const lastChild = node.children?.[node.children.length - 1];

  if (lastChild?.type !== "text" || typeof lastChild.value !== "string") {
    return;
  }

  const match = lastChild.value.match(LEGACY_ID_PATTERN);

  if (!match) {
    return;
  }

  const [, id] = match;
  const cleaned = lastChild.value.replace(LEGACY_ID_PATTERN, "");

  lastChild.value = cleaned;
  node.data ??= {};
  node.data.id = id;
  node.data.hProperties = {
    ...(node.data.hProperties ?? {}),
    id,
  };
}

export function remarkLegacyHeadingIds() {
  return (tree: TreeNode) => {
    visit(tree, (node) => {
      if (node.type === "heading") {
        applyLegacyId(node as HeadingNode);
      }
    });
  };
}
