"use client";

import {
  MarkdownCopyButton as FumadocsMarkdownCopyButton,
  ViewOptionsPopover as FumadocsViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";

interface LLMCopyButtonProps {
  markdownUrl: string;
  className?: string;
}

interface ViewOptionsProps {
  markdownUrl: string;
  githubUrl?: string;
  className?: string;
}

export function LLMCopyButton(props: LLMCopyButtonProps) {
  return <FumadocsMarkdownCopyButton {...props} />;
}

export function ViewOptions(props: ViewOptionsProps) {
  return <FumadocsViewOptionsPopover {...props} />;
}
