"use client";

import {
  MarkdownCopyButton as FumadocsMarkdownCopyButton,
  ViewOptionsPopover as FumadocsViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";

type LLMCopyButtonProps = {
  markdownUrl: string;
  className?: string;
};

type ViewOptionsProps = {
  markdownUrl: string;
  githubUrl?: string;
  className?: string;
};

export function LLMCopyButton(props: LLMCopyButtonProps) {
  return <FumadocsMarkdownCopyButton {...props} />;
}

export function ViewOptions(props: ViewOptionsProps) {
  return <FumadocsViewOptionsPopover {...props} />;
}
