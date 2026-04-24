export function formatOpenSpecDate(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const isoDate = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDate?.[1]) {
    return isoDate[1];
  }

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}
