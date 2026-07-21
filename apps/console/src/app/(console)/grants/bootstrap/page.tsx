// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { permanentRedirect } from "next/navigation";

// Owner-token issuance moved to /deployment/tokens to align with how
// every mature operator product (GitHub, Stripe, Vercel, Linear) shelves
// developer-mode tokens — under settings/deployment, not under a resource-type
// page like "Grants." Permanent redirect keeps any stored bookmarks working.
export default function OwnerTokenBootstrapRedirect() {
  permanentRedirect("/deployment/tokens");
}
