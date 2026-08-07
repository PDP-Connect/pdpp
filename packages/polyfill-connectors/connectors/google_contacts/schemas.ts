// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

const nameSchema = z.object({
  display_name: pdppSafeText.max(500).nullable(),
  family_name: pdppSafeText.max(250).nullable(),
  given_name: pdppSafeText.max(250).nullable(),
});

const emailSchema = z.object({
  type: z.string().max(64).nullable(),
  value: z.string().max(320).nullable(),
});

const phoneSchema = z.object({
  type: z.string().max(64).nullable(),
  value: z.string().max(64).nullable(),
});

const addressSchema = z.object({
  city: pdppSafeText.max(250).nullable(),
  formatted_value: pdppSafeText.max(2000).nullable(),
  type: z.string().max(64).nullable(),
});

const organizationSchema = z.object({
  name: pdppSafeText.max(500).nullable(),
  title: pdppSafeText.max(500).nullable(),
});

export const peopleSchema = z.object({
  id: z.string().min(1),
  resource_name: z.string().min(1),
  deleted: z.boolean(),
  display_name: pdppSafeText.max(500).nullable(),
  names: z.array(nameSchema),
  email_addresses: z.array(emailSchema),
  phone_numbers: z.array(phoneSchema),
  addresses: z.array(addressSchema),
  organizations: z.array(organizationSchema),
  biography: pdppSafeText.max(10_000).nullable(),
  nickname: pdppSafeText.max(250).nullable(),
  photo_url: z.string().max(2048).nullable(),
  contact_group_resource_names: z.array(z.string()),
  updated: z.string().datetime({ offset: true }).nullable(),
  source: z.literal("google_people_api"),
});

export const contactGroupsSchema = z.object({
  id: z.string().min(1),
  resource_name: z.string().min(1),
  name: pdppSafeText.max(500).nullable(),
  member_count: z.number().int().nonnegative(),
  source: z.literal("google_people_api"),
});

const SCHEMAS = {
  people: peopleSchema,
  contact_groups: contactGroupsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
