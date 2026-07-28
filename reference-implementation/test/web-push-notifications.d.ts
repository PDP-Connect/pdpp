// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ambient declaration for the `web-push` npm package, which ships no bundled
 * types and has no `@types/web-push`. TypeScript refuses a `declare module
 * 'web-push'` block written inside a .ts file for a package that already
 * resolves to an untyped JS module ("cannot be augmented") — an ambient
 * module declaration for a fully-untyped third-party package must live in a
 * .d.ts file. Scoped to web-push-notifications.test.ts, the only consumer in
 * this cohort. Covers only the members that file actually calls:
 * setVapidDetails/sendNotification (the runtime seam) and generateVAPIDKeys
 * (real VAPID test keys, generated once at module load).
 */
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver cannot model this installed package export
declare module "web-push" {
  export function generateVAPIDKeys(): { privateKey: string; publicKey: string };
  export function sendNotification(
    subscription: { endpoint: string; keys: { auth: string; p256dh: string } },
    payload: unknown,
    options?: Record<string, unknown>
  ): Promise<{ headers: unknown; statusCode: number }>;
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
}
