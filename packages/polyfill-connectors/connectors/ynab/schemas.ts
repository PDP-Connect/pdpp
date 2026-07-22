// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for YNAB stream records. Used for shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events.
 *
 * YNAB uses milliunits for amounts (1000 = 1 currency unit). All amounts
 * are integers with no magnitude constraints; debits are negative.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
// YNAB IDs are UUID v4 lowercase. Transactions sometimes append a
// _<date> or _t_<date> suffix for scheduled-instance and transfer
// pair IDs (observed in real data).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSACTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_t)?(_\d{4}-\d{2}-\d{2})?$/;
// month_categories.id is composite: budget_id:month:category_id
const MONTH_CATEGORY_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{4}-\d{2}-\d{2}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// months.id is composite: budget_id|month
const MONTHS_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|/;
// ISO dates (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const budgetsSchema = z.object({
  id: z.string().regex(UUID_RE, "id must be UUID v4"),
  name: z.string(),
  last_modified_on: z.string().regex(ISO_DATETIME_RE, "last_modified_on must be ISO-8601 datetime").nullable(),
  first_month: z.string().regex(ISO_DATE_RE, "first_month must be ISO-8601 date").nullable(),
  last_month: z.string().regex(ISO_DATE_RE, "last_month must be ISO-8601 date").nullable(),
  currency_iso_code: z.string().nullable(),
  currency_symbol: z.string().nullable(),
  currency_symbol_first: z.boolean().nullable(),
  currency_decimal_digits: z.number().int().nullable(),
  currency_decimal_separator: z.string().nullable(),
  currency_group_separator: z.string().nullable(),
  date_format_string: z.string().nullable(),
  deleted: z.boolean(),
});

// Account entity: identity and settings fields only. The point-in-time
// balance metrics live on `account_stats` (see `accountStatsSchema`) so a
// balance move does not version the entity record.
export const accountsSchema = z.object({
  id: z.string().regex(UUID_RE, "id must be UUID v4"),
  budget_id: z.string().regex(UUID_RE, "budget_id must be UUID v4"),
  name: z.string(),
  type: z.string(),
  on_budget: z.boolean(),
  closed: z.boolean(),
  transfer_payee_id: z.string().regex(UUID_RE, "transfer_payee_id must be UUID v4").nullable(),
  direct_import_linked: z.boolean().nullable(),
  direct_import_in_error: z.boolean().nullable(),
  last_reconciled_at: z.string().regex(ISO_DATETIME_RE, "last_reconciled_at must be ISO-8601 datetime").nullable(),
  note: z.string().nullable(),
  debt_interest_rates: z.record(z.string(), z.unknown()).nullable(),
  debt_minimum_payments: z.record(z.string(), z.unknown()).nullable(),
  debt_escrow_amounts: z.record(z.string(), z.unknown()).nullable(),
  deleted: z.boolean(),
});

// Append-keyed daily balance observation. `id` is `{account_id}:{observed_on}`,
// so one record covers one account per UTC calendar day. Balances are YNAB
// milliunit integers (debits negative).
export const accountStatsSchema = z.object({
  id: z.string().regex(/^[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/, "id must be {account_id}:{YYYY-MM-DD}"),
  account_id: z.string().regex(UUID_RE, "account_id must be UUID v4"),
  budget_id: z.string().regex(UUID_RE, "budget_id must be UUID v4"),
  observed_on: z.string().regex(ISO_DATE_RE, "observed_on must be ISO-8601 date"),
  balance: z.number().int(),
  cleared_balance: z.number().int(),
  uncleared_balance: z.number().int(),
});

export const categoryGroupsSchema = z.object({
  id: z.string().regex(UUID_RE, "id must be UUID v4"),
  budget_id: z.string().regex(UUID_RE, "budget_id must be UUID v4"),
  name: z.string(),
  hidden: z.boolean(),
  note: z.string().nullable(),
  deleted: z.boolean(),
});

export const categoriesSchema = z.object({
  id: z.string().regex(UUID_RE, "id must be UUID v4"),
  budget_id: z.string().regex(UUID_RE, "budget_id must be UUID v4"),
  category_group_id: z.string().regex(UUID_RE, "category_group_id must be UUID v4"),
  category_group_name: z.string().nullable(),
  name: z.string(),
  hidden: z.boolean(),
  budgeted: z.number().int(),
  activity: z.number().int(),
  balance: z.number().int(),
  note: z.string().nullable(),
  goal_type: z.string().nullable(),
  goal_needs_whole_amount: z.boolean().nullable(),
  goal_day: z.number().int().nullable(),
  goal_cadence: z.number().int().nullable(),
  goal_cadence_frequency: z.number().int().nullable(),
  goal_creation_month: z.string().regex(ISO_DATE_RE, "goal_creation_month must be ISO-8601 date").nullable(),
  goal_target: z.number().int().nullable(),
  goal_target_date: z.string().regex(ISO_DATE_RE, "goal_target_date must be YYYY-MM-DD").nullable(),
  goal_percentage_complete: z.number().int().nullable(),
  goal_months_to_budget: z.number().int().nullable(),
  goal_under_funded: z.number().int().nullable(),
  goal_overall_funded: z.number().int().nullable(),
  goal_overall_left: z.number().int().nullable(),
  goal_snoozed_at: z.string().regex(ISO_DATETIME_RE, "goal_snoozed_at must be ISO-8601 datetime").nullable(),
  deleted: z.boolean(),
});

export const payeesSchema = z.object({
  id: z.string().regex(UUID_RE, "id must be UUID v4"),
  budget_id: z.string().regex(UUID_RE, "budget_id must be UUID v4"),
  name: z.string(),
  transfer_account_id: z.string().regex(UUID_RE, "transfer_account_id must be UUID v4").nullable(),
  deleted: z.boolean(),
});

export const payeeLocationsSchema = z.object({
  id: z.string().regex(UUID_RE, "id must be UUID v4"),
  budget_id: z.string().regex(UUID_RE, "budget_id must be UUID v4"),
  payee_id: z.string().regex(UUID_RE, "payee_id must be UUID v4"),
  latitude: z.string(),
  longitude: z.string(),
  deleted: z.boolean(),
});

export const transactionsSchema = z.object({
  id: z.string().regex(TRANSACTION_ID_RE, "id must be UUID, optionally with _t and/or _<date> suffix"),
  budget_id: z.string().regex(UUID_RE, "budget_id must be UUID v4"),
  account_id: z.string().regex(UUID_RE, "account_id must be UUID v4"),
  account_name: z.string().nullable(),
  account_type: z.string().nullable(),
  date: z.string().regex(ISO_DATE_RE, "date must be ISO-8601 date"),
  amount: z.number().int(),
  payee_id: z.string().regex(UUID_RE, "payee_id must be UUID v4").nullable(),
  payee_name: z.string().nullable(),
  category_id: z.string().regex(UUID_RE, "category_id must be UUID v4").nullable(),
  category_name: z.string().nullable(),
  memo: z.string().nullable(),
  cleared: z.string(),
  approved: z.boolean(),
  flag_color: z.string().nullable(),
  flag_name: z.string().nullable(),
  transfer_account_id: z.string().regex(UUID_RE, "transfer_account_id must be UUID v4").nullable(),
  transfer_transaction_id: z
    .string()
    .regex(TRANSACTION_ID_RE, "transfer_transaction_id must be UUID, optionally with _t and/or _<date> suffix")
    .nullable(),
  matched_transaction_id: z
    .string()
    .regex(TRANSACTION_ID_RE, "matched_transaction_id must be UUID, optionally with _t and/or _<date> suffix")
    .nullable(),
  import_id: z.string().nullable(),
  import_payee_name: z.string().nullable(),
  import_payee_name_original: z.string().nullable(),
  debt_transaction_type: z.string().nullable(),
  is_split: z.boolean(),
  subtransactions: z.array(z.unknown()),
  deleted: z.boolean(),
});

export const scheduledTransactionsSchema = z.object({
  id: z.string().regex(UUID_RE, "id must be UUID v4"),
  budget_id: z.string().regex(UUID_RE, "budget_id must be UUID v4"),
  date_first: z.string().regex(ISO_DATE_RE, "date_first must be ISO-8601 date"),
  date_next: z.string().regex(ISO_DATE_RE, "date_next must be ISO-8601 date"),
  frequency: z.string(),
  amount: z.number().int(),
  account_id: z.string().regex(UUID_RE, "account_id must be UUID v4"),
  account_name: z.string().nullable(),
  payee_id: z.string().regex(UUID_RE, "payee_id must be UUID v4").nullable(),
  payee_name: z.string().nullable(),
  category_id: z.string().regex(UUID_RE, "category_id must be UUID v4").nullable(),
  category_name: z.string().nullable(),
  memo: z.string().nullable(),
  transfer_account_id: z.string().regex(UUID_RE, "transfer_account_id must be UUID v4").nullable(),
  flag_color: z.string().nullable(),
  flag_name: z.string().nullable(),
  subtransactions: z.array(z.unknown()),
  deleted: z.boolean(),
});

export const monthsSchema = z.object({
  id: z.string().regex(MONTHS_ID_RE, "months.id must be budget_id|month"),
  budget_id: z.string().regex(UUID_RE, "budget_id must be UUID v4"),
  month: z.string().regex(ISO_DATE_RE, "month must be ISO-8601 date"),
  income: z.number().int(),
  budgeted: z.number().int(),
  activity: z.number().int(),
  to_be_budgeted: z.number().int(),
  age_of_money: z.number().int().nullable(),
  note: z.string().nullable(),
  deleted: z.boolean(),
});

export const monthCategoriesSchema = z.object({
  id: z.string().regex(MONTH_CATEGORY_ID_RE, "month_categories.id must be budget_id:month:category_id"),
  budget_id: z.string().regex(UUID_RE, "budget_id must be UUID v4"),
  month: z.string().regex(ISO_DATE_RE, "month must be ISO-8601 date"),
  category_id: z.string().regex(UUID_RE, "category_id must be UUID v4"),
  category_name: z.string(),
  category_group_id: z.string().regex(UUID_RE, "category_group_id must be UUID v4").nullable(),
  category_group_name: z.string().nullable(),
  budgeted: z.number().int(),
  activity: z.number().int(),
  balance: z.number().int(),
  goal_type: z.string().nullable(),
  goal_target: z.number().int().nullable(),
  goal_percentage_complete: z.number().int().nullable(),
  goal_months_to_budget: z.number().int().nullable(),
  goal_creation_month: z.string().regex(ISO_DATE_RE, "goal_creation_month must be ISO-8601 date").nullable(),
  goal_under_funded: z.number().int().nullable(),
  goal_overall_funded: z.number().int().nullable(),
  goal_overall_left: z.number().int().nullable(),
  hidden: z.boolean(),
  note: z.string().nullable(),
  deleted: z.boolean(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  budgets: budgetsSchema,
  accounts: accountsSchema,
  account_stats: accountStatsSchema,
  category_groups: categoryGroupsSchema,
  categories: categoriesSchema,
  payees: payeesSchema,
  payee_locations: payeeLocationsSchema,
  transactions: transactionsSchema,
  scheduled_transactions: scheduledTransactionsSchema,
  months: monthsSchema,
  month_categories: monthCategoriesSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
