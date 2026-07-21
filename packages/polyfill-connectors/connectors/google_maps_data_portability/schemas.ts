import { z } from "zod";

import { makeValidateRecord } from "../../src/schema-registry.ts";

const nullableDateTime = z.string().datetime().nullable();

export const archiveJobsSchema = z.object({
  access_type: z.string().nullable(),
  archive_job_id: z.string().nullable(),
  download_url_count: z.number().int().nonnegative(),
  export_time: nullableDateTime,
  id: z.string(),
  resource_group: z.string(),
  source: z.literal("google_data_portability_api"),
  start_time: nullableDateTime,
  state: z.string().nullable(),
});

const SCHEMAS = {
  archive_jobs: archiveJobsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
