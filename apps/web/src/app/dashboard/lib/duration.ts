export function formatDurationCompact(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) {
    return "";
  }
  if (seconds % (24 * 60 * 60) === 0) {
    return `${seconds / (24 * 60 * 60)}d`;
  }
  if (seconds % (60 * 60) === 0) {
    return `${seconds / (60 * 60)}h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }
  return `${seconds}s`;
}
