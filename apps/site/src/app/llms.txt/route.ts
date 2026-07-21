// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const revalidate = false;
export const dynamic = "force-dynamic";

export async function GET() {
  const [{ llms }, { agentSkillsLLMSIndex }, { source }] = await Promise.all([
    import("fumadocs-core/source"),
    import("@/lib/agent-skills/catalog.ts"),
    import("@/lib/docs-source.ts"),
  ]);

  return new Response(`${llms(source).index()}\n\n${agentSkillsLLMSIndex()}\n`, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
    },
  });
}
