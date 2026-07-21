export const revalidate = false;
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { agentSkillsLLMSIndex } = await import("../../lib/agent-skills/catalog.ts");

  return new Response(`# PDPP operator agent entrypoints\n\n${agentSkillsLLMSIndex()}\n`, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
    },
  });
}
