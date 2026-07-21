export const revalidate = false;
export const dynamic = "force-dynamic";

const TRAILING_COLON = /:$/;

interface SkillRouteContext {
  params: Promise<{
    path?: string[];
  }>;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function notFound(): Response {
  return jsonResponse(
    {
      error: {
        type: "not_found_error",
        code: "not_found",
        message: "Skill file not found",
      },
    },
    { status: 404 }
  );
}

function resolvePublicOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost || request.headers.get("host");
  if (!host) {
    return url.origin;
  }
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const protocol = forwardedProto || url.protocol.replace(TRAILING_COLON, "");
  return `${protocol}://${host}`;
}

export async function GET(request: Request, context: SkillRouteContext): Promise<Response> {
  const { path = [] } = await context.params;
  const routePath = path.join("/");
  const { buildAgentSkillCatalog, readAgentSkillFile } = await import("../../../../lib/agent-skills/catalog.ts");

  if (routePath === "index.json") {
    return jsonResponse(await buildAgentSkillCatalog(resolvePublicOrigin(request)));
  }

  const file = await readAgentSkillFile(routePath);
  if (!file) {
    return notFound();
  }

  return new Response(new Uint8Array(file.body), {
    headers: {
      "content-type": file.definition.mediaType,
      "x-content-type-options": "nosniff",
    },
  });
}
