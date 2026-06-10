export const revalidate = false;
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { agentSkillsLLMSFullText } = await import("../../lib/agent-skills/catalog.ts");

  return new Response(await agentSkillsLLMSFullText(), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
    },
  });
}
