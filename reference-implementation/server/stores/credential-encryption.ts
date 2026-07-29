// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Reversible encryption-at-rest for per-connection static-secret credentials.
 *
 * Unlike the device-exporter store, which one-way *hashes* device tokens it only
 * ever needs to verify, a provider static secret must be *recovered* so the
 * orchestrator can authenticate to the provider on the connection's behalf. So
 * this is authenticated reversible encryption (AES-256-GCM), not a hash. See
 * `add-static-secret-owner-connect-primitive` design Decision 1.
 *
 * The encryption key is owner/operator-held (an instance/server secret), never
 * agent-held or client-held. It is provided out-of-band through a small
 * key-provider adapter: `PDPP_CREDENTIAL_ENCRYPTION_KEY` for platforms whose
 * secret manager exposes env vars (Railway), or
 * `PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE` for Docker/Kubernetes-style secret
 * mounts. When credential encryption is required but no provider is configured,
 * callers MUST fail closed with a clear operator error rather than storing
 * plaintext.
 *
 * Wire format of a sealed credential (a single opaque string, versioned so the
 * key-derivation / cipher can evolve without ambiguity):
 *
 *   v1:<salt_b64>:<iv_b64>:<authTag_b64>:<ciphertext_b64>
 *
 * Each seal draws a fresh random salt and IV, so two seals of the same plaintext
 * under the same key produce different ciphertext. Nothing here ever logs, throws
 * with, or otherwise surfaces the plaintext or the key.
 */

export const CREDENTIAL_ENCRYPTION_KEY_ENV = "PDPP_CREDENTIAL_ENCRYPTION_KEY";
export const CREDENTIAL_ENCRYPTION_KEY_FILE_ENV = "PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE";
const SEALED_VERSION = "v1";
const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
// scrypt cost parameters. N must be a power of two; these are the Node defaults
// and are adequate for an at-rest key-stretch over an already-high-entropy
// operator secret. `maxmem` is widened so the chosen N does not trip the
// default 32 MiB ceiling.
const SCRYPT_PARAMS = Object.freeze({ maxmem: 64 * 1024 * 1024, N: 16_384, p: 1, r: 8 });

export class CredentialEncryptionError extends Error {
  code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialEncryptionError";
    this.code = code;
  }
}

/**
 * Resolve the operator-held encryption key material from the environment.
 * Returns `null` when unconfigured so callers can decide whether the absence is
 * a fail-closed condition (it is, anywhere a credential must be stored).
 */
export function resolveCredentialEncryptionKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  const keyFile = env[CREDENTIAL_ENCRYPTION_KEY_FILE_ENV];
  if (typeof keyFile !== "string" || keyFile.trim().length === 0) {
    return null;
  }
  const path = keyFile.trim();
  let fileValue: string;
  try {
    fileValue = readFileSync(path, "utf8");
  } catch (cause) {
    const error = new CredentialEncryptionError(
      "credential_encryption_key_file_unreadable",
      `Credential encryption key file '${path}' could not be read. ` +
        `Set ${CREDENTIAL_ENCRYPTION_KEY_ENV} or mount a readable file via ${CREDENTIAL_ENCRYPTION_KEY_FILE_ENV}.`
    );
    error.cause = cause;
    throw error;
  }
  const trimmed = fileValue.trim();
  if (!trimmed) {
    throw new CredentialEncryptionError(
      "credential_encryption_key_invalid",
      `Credential encryption key file '${path}' is empty.`
    );
  }
  return trimmed;
}

/**
 * Build a cipher instance from explicit key material. Prefer
 * {@link createCredentialCipherFromEnv} in production; this entry point exists so
 * tests can configure a deterministic key without weakening production behavior
 * (the production path is identical, only the key source differs).
 */
export interface CredentialCipher {
  fingerprint: (plaintext: string) => string | null;
  open: (sealed: string) => string;
  seal: (plaintext: string) => string;
}

export function createCredentialCipher(keyMaterial: string): CredentialCipher {
  if (typeof keyMaterial !== "string" || keyMaterial.trim().length === 0) {
    throw new CredentialEncryptionError(
      "credential_encryption_key_invalid",
      "Credential encryption key material must be a non-empty string."
    );
  }
  const secret = keyMaterial.trim();

  function deriveKey(salt: Buffer): Buffer {
    return scryptSync(secret, salt, KEY_BYTES, SCRYPT_PARAMS);
  }

  return {
    /**
     * Non-secret fingerprint of a plaintext credential, for diagnostics that must
     * distinguish "the secret changed" from "the secret is the same" without
     * revealing any bytes. Derived under the operator key + a fixed domain salt so
     * it is stable for a given (key, plaintext) pair but useless without the key.
     *
     * v2: widened from 8 bytes (64-bit, ~2^32 birthday bound) to 16 bytes (128-bit)
     * to eliminate practical collision risk. The operator key already provides
     * per-deployment uniqueness that defeats global precomputed tables. The domain
     * string change to v2 ensures a clean break from any cached v1 values.
     */
    fingerprint(plaintext) {
      if (typeof plaintext !== "string" || plaintext.length === 0) {
        return null;
      }
      const salt = Buffer.from("pdpp.credential.fingerprint.v2", "utf8");
      return scryptSync(`${secret}\n${plaintext}`, salt, 16, SCRYPT_PARAMS).toString("hex");
    },

    /**
     * Recover plaintext from a sealed token. Throws a typed error on a malformed
     * token or on authentication failure (wrong key / tampered ciphertext). The
     * error message never contains the plaintext or the key.
     */
    open(sealed) {
      if (typeof sealed !== "string") {
        throw new CredentialEncryptionError("credential_sealed_invalid", "Sealed credential must be a string.");
      }
      const parts = sealed.split(":");
      if (parts.length !== 5 || parts[0] !== SEALED_VERSION) {
        throw new CredentialEncryptionError(
          "credential_sealed_invalid",
          "Sealed credential is malformed or uses an unsupported version."
        );
      }
      const [, saltB64, ivB64, authTagB64, ciphertextB64] = parts;
      if (!(saltB64 && ivB64 && authTagB64 && ciphertextB64)) {
        throw new CredentialEncryptionError(
          "credential_sealed_invalid",
          "Sealed credential is malformed or uses an unsupported version."
        );
      }
      let salt: Buffer;
      let iv: Buffer;
      let authTag: Buffer;
      let ciphertext: Buffer;
      try {
        salt = Buffer.from(saltB64, "base64");
        iv = Buffer.from(ivB64, "base64");
        authTag = Buffer.from(authTagB64, "base64");
        ciphertext = Buffer.from(ciphertextB64, "base64");
      } catch (cause) {
        const error = new CredentialEncryptionError(
          "credential_sealed_invalid",
          "Sealed credential has invalid encoding."
        );
        error.cause = cause;
        throw error;
      }
      if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
        throw new CredentialEncryptionError(
          "credential_sealed_invalid",
          "Sealed credential has invalid field lengths."
        );
      }
      const key = deriveKey(salt);
      const decipher = createDecipheriv(CIPHER, key, iv, { authTagLength: AUTH_TAG_BYTES });
      decipher.setAuthTag(authTag);
      try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch (cause) {
        // GCM authentication failed: wrong key or tampered ciphertext. Do not
        // leak which, and never echo the ciphertext.
        const error = new CredentialEncryptionError(
          "credential_decrypt_failed",
          "Failed to decrypt credential: wrong encryption key or corrupted ciphertext."
        );
        error.cause = cause;
        throw error;
      }
    },
    /**
     * Encrypt plaintext into a single opaque versioned token. The plaintext is
     * never returned in, attached to, or logged by the result.
     */
    seal(plaintext) {
      if (typeof plaintext !== "string" || plaintext.length === 0) {
        throw new CredentialEncryptionError(
          "credential_plaintext_invalid",
          "Credential plaintext must be a non-empty string."
        );
      }
      const salt = randomBytes(SALT_BYTES);
      const iv = randomBytes(IV_BYTES);
      const key = deriveKey(salt);
      const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: AUTH_TAG_BYTES });
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return [
        SEALED_VERSION,
        salt.toString("base64"),
        iv.toString("base64"),
        authTag.toString("base64"),
        ciphertext.toString("base64"),
      ].join(":");
    },
  };
}

/**
 * Production entry point: build a cipher from the operator-held env key, or fail
 * closed with a clear, secret-free operator error when it is absent. Callers that
 * must store or recover a credential use this; the fail-closed error is the
 * load-bearing guard that prevents plaintext-at-rest.
 */
export function createCredentialCipherFromEnv(env: NodeJS.ProcessEnv = process.env): CredentialCipher {
  const key = resolveCredentialEncryptionKey(env);
  if (!key) {
    throw new CredentialEncryptionError(
      "credential_encryption_key_missing",
      `Credential encryption is required but neither ${CREDENTIAL_ENCRYPTION_KEY_ENV} nor ` +
        `${CREDENTIAL_ENCRYPTION_KEY_FILE_ENV} is configured. ` +
        "Set an owner/operator-held key provider before capturing static-secret credentials. " +
        "No plaintext credential is ever stored without it."
    );
  }
  return createCredentialCipher(key);
}

/** True when an operator key is configured and credential capture can proceed. */
export function isCredentialEncryptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return resolveCredentialEncryptionKey(env) !== null;
  } catch {
    return false;
  }
}

/**
 * Constant-time equality for two fingerprints (or any two same-length strings).
 * Exposed so callers comparing fingerprints don't reach for `===` on
 * secret-derived material.
 */
export function fingerprintsEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}
