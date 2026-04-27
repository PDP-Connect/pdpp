import { llms } from "fumadocs-core/source";
import { agentSkillsLLMSIndex } from "@/lib/agent-skills/catalog.ts";
import { source } from "@/lib/docs-source.ts";

export const revalidate = false;

export function GET() {
  return new Response(`${llms(source).index()}\n\n${agentSkillsLLMSIndex()}\n`, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
    },
  });
}
