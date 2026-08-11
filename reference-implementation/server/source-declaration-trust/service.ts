// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Small composition boundary for standalone provider-native declaration trust.
 * It has no grant, consent, catalog, or onboarding dependency: callers supply
 * an authority binding already accepted by their onboarding path.
 */

import {
  type DeclarationRetrievalDependencies,
  type DeclarationRetrievalPolicy,
  retrieveSourceDeclaration,
} from "./retrieval.ts";
import type { AcceptedSourceDeclarationRevisionStore } from "./revision-store.ts";

export type AcceptProviderNativeDeclarationResult =
  | { readonly ok: true; readonly declarationVersion: string; readonly finalUrl: string }
  | { readonly ok: false; readonly reason: string };

export async function retrieveAndAcceptProviderNativeDeclaration(
  input: {
    readonly acceptedPointer: string;
    readonly authorityBinding: string;
    readonly expectedSourceId: string;
  },
  dependencies: DeclarationRetrievalDependencies & {
    readonly revisionStore: AcceptedSourceDeclarationRevisionStore;
  },
  policy: DeclarationRetrievalPolicy
): Promise<AcceptProviderNativeDeclarationResult> {
  const retrieved = await retrieveSourceDeclaration(
    { acceptedPointer: input.acceptedPointer, expectedSourceId: input.expectedSourceId },
    policy,
    dependencies
  );
  if (!retrieved.ok) {
    return retrieved;
  }
  const persisted = await dependencies.revisionStore.accept({
    authorityBinding: input.authorityBinding,
    declarationVersion: retrieved.value.declaration.declaration_version,
    parsedDeclaration: retrieved.value.declaration,
    sourceId: input.expectedSourceId,
  });
  if (!persisted.accepted) {
    return { ok: false, reason: persisted.reason };
  }
  return {
    declarationVersion: retrieved.value.declaration.declaration_version,
    finalUrl: retrieved.value.finalUrl,
    ok: true,
  };
}
