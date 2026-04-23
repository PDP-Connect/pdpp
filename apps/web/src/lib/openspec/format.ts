export function formatOpenSpecDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toISOString().slice(0, 10);
}
