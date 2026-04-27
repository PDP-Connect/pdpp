import { agentSkillsLLMSFullText } from "@/lib/agent-skills/catalog.ts";
import { source } from "@/lib/docs-source.ts";
import { getLLMText } from "@/lib/get-llm-text.ts";

export const revalidate = false;

export async function GET() {
  const scan = source.getPages().map(getLLMText);
  const [scanned, skillText] = await Promise.all([Promise.all(scan), agentSkillsLLMSFullText()]);

  return new Response(`${scanned.join("\n\n")}\n\n${skillText}`, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
    },
  });
}
