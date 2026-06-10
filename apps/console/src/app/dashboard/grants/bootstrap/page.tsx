import { permanentRedirect } from "next/navigation";

// Owner-token issuance moved to /dashboard/deployment/tokens to align with how
// every mature operator product (GitHub, Stripe, Vercel, Linear) shelves
// developer-mode tokens — under settings/deployment, not under a resource-type
// page like "Grants." Permanent redirect keeps any stored bookmarks working.
export default function OwnerTokenBootstrapRedirect() {
  permanentRedirect("/dashboard/deployment/tokens");
}
