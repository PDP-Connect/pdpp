export const revalidate = false;
export const dynamic = "force-dynamic";

export async function GET() {
  const [{ agentSkillsLLMSFullText }, { source }, { getLLMText }] = await Promise.all([
    import("@/lib/agent-skills/catalog.ts"),
    import("@/lib/docs-source.ts"),
    import("@/lib/get-llm-text.ts"),
  ]);
  const scan = source.getPages().map(getLLMText);
  const [scanned, skillText] = await Promise.all([Promise.all(scan), agentSkillsLLMSFullText()]);

  return new Response(`${scanned.join("\n\n")}\n\n${skillText}`, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
    },
  });
}
