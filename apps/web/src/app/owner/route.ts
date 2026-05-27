import { proxyReferenceRequest } from "../reference-proxy.ts";

const path = ["owner"] as const;

export const GET = (request: Request) => proxyReferenceRequest(request, "as", path);
export const POST = GET;
