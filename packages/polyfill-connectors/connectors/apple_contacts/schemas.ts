// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Apple Contacts stream records. See
 * docs/reference/connector-authoring-guide.md §3: records that don't match
 * the schema become SKIP_RESULT events instead of RECORD events.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

const typedValueSchema = z.object({
  types: z.array(z.string()),
  value: z.string(),
});

const addressSchema = z.object({
  types: z.array(z.string()),
  value: z.string(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  extended: z.string().nullable(),
  po_box: z.string().nullable(),
  postal_code: z.string().nullable(),
  region: z.string().nullable(),
  street: z.string().nullable(),
});

export const contactsSchema = z.object({
  id: z.string().min(1),
  addressbook_url: z.string(),
  uid: z.string().nullable(),
  display_name: z.string().nullable(),
  family_name: z.string().nullable(),
  given_name: z.string().nullable(),
  org: z.string().nullable(),
  title: z.string().nullable(),
  note: z.string().nullable(),
  birthday: z.string().nullable(),
  emails: z.array(typedValueSchema),
  phones: z.array(typedValueSchema),
  addresses: z.array(addressSchema),
  has_photo: z.boolean(),
  photo_media_type: z.string().nullable(),
  photo_base64: z.string().nullable(),
  etag: z.string().nullable(),
  rev: z.string().nullable(),
  deleted: z.boolean(),
});

export const addressBooksSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().nullable(),
  url: z.string(),
  supports_sync_collection: z.boolean(),
  deleted: z.boolean(),
});

export const contactGroupsSchema = z.object({
  id: z.string().min(1),
  addressbook_url: z.string(),
  name: z.string(),
  member_uids: z.array(z.string()),
  deleted: z.boolean(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  contacts: contactsSchema,
  address_books: addressBooksSchema,
  contact_groups: contactGroupsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
