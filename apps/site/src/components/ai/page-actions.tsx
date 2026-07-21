// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import {
  MarkdownCopyButton as FumadocsMarkdownCopyButton,
  ViewOptionsPopover as FumadocsViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";

interface LLMCopyButtonProps {
  className?: string;
  markdownUrl: string;
}

interface ViewOptionsProps {
  className?: string;
  githubUrl?: string;
  markdownUrl: string;
}

export function LLMCopyButton(props: LLMCopyButtonProps) {
  return <FumadocsMarkdownCopyButton {...props} />;
}

export function ViewOptions(props: ViewOptionsProps) {
  return <FumadocsViewOptionsPopover {...props} />;
}
