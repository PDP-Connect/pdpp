export type ConnectorPublicTier = "supported" | "preview" | "development";

const ALLOWED_KEYS = new Set(["tier", "proof_gate", "rationale"]);
const TIERS = new Set<ConnectorPublicTier>(["supported", "preview", "development"]);

export function publicListingTierError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "capabilities.public_listing must be an object when declared";
  }
  const listing = value as Record<string, unknown>;
  const unknownKeys = Object.keys(listing).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length) {
    return `capabilities.public_listing has unsupported keys: ${unknownKeys.join(", ")}`;
  }
  const { tier } = listing;
  if (typeof tier !== "string" || !TIERS.has(tier as ConnectorPublicTier)) {
    return "capabilities.public_listing.tier must be one of: supported, preview, development";
  }
  return null;
}
