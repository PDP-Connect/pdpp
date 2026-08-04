/**
 * Verify shared sanitizer module is correctly exported via package.json.
 * This test MUST fail if the export entry is removed from package.json,
 * ensuring the export is actually load-bearing.
 */
import { applySanitizationRegexes, redactLegacyInteractionString } from "pdpp-reference-implementation/lib/legacy-interaction-sanitizer";

export default async function testLibExports() {
  // Test applySanitizationRegexes
  const withUrl = applySanitizationRegexes("Visit https://example.com for info");
  if (!withUrl.includes("[REDACTED_URL]")) {
    throw new Error("URL redaction failed");
  }

  // Test 6-digit OTP (the key missing-from-runtime fix)
  const withOtp = applySanitizationRegexes("Your code is 123456");
  if (!withOtp.includes("[REDACTED_OTP]")) {
    throw new Error("6-digit OTP redaction failed");
  }

  // Test redactLegacyInteractionString with bounding
  const result = redactLegacyInteractionString("Bearer abc123def456", 100);
  if (!result || !result.includes("[REDACTED]")) {
    throw new Error("Bearer token redaction failed");
  }

  return { status: "pass", description: "lib exports verified" };
}
