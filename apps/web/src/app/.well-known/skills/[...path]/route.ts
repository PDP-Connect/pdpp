import { buildAgentSkillCatalog, readAgentSkillFile } from "@/lib/agent-skills/catalog.ts";

export const revalidate = false;

interface RouteContext {
  params: Promise<{ path?: string[] }>;
}

export async function GET(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  const routePath = path.join("/");

  if (routePath === "index.json") {
    return Response.json(await buildAgentSkillCatalog(new URL(request.url).origin), {
      headers: {
        "cache-control": "public, max-age=300",
      },
    });
  }

  const file = await readAgentSkillFile(routePath);
  if (!file) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(file.body.toString("utf8"), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": file.definition.mediaType,
    },
  });
}
