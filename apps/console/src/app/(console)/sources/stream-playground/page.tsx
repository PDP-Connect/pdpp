import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function StreamPlaygroundAliasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(await searchParams)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (typeof value === "string") {
        params.append(key, value);
      }
    }
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  redirect(`/stream-playground${suffix}`);
}
