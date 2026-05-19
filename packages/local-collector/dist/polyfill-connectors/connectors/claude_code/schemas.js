import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.js";
import { PDPP_PREVIEW_MAX_CHARS, safeTextPreview } from "../../src/safe-text-preview.js";
import { makeValidateRecord } from "../../src/schema-registry.js";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const uuidSchema = z.string().regex(UUID_RE, "must be valid UUID");
const isoDateTimeSchema = z.string().regex(ISO_Z_RE, "must be ISO-8601 with millis and Z suffix").nullable();
const stringMaxSchema = (max) => pdppSafeText.max(max).nullable();
const pathSchema = pdppSafeText.max(2048).nullable();
export const sessionsSchema = z.object({
    id: uuidSchema,
    project_path: pdppSafeText,
    cwd: pathSchema,
    git_branch: stringMaxSchema(256),
    version: stringMaxSchema(64),
    started_at: isoDateTimeSchema,
    last_event_at: isoDateTimeSchema,
    message_count: z.number().int().min(0).nullable(),
    user_type: stringMaxSchema(40),
    entrypoint: stringMaxSchema(256),
});
export const messagesSchema = z.object({
    id: uuidSchema,
    session_id: uuidSchema,
    parent_uuid: uuidSchema.nullable(),
    role: stringMaxSchema(64),
    type: stringMaxSchema(64),
    content: pdppSafeText.max(10_000_000).nullable(),
    timestamp: isoDateTimeSchema,
    is_sidechain: z.boolean(),
    user_type: stringMaxSchema(40),
    agent_id: stringMaxSchema(256).nullable(),
});
export const attachmentsSchema = z.object({
    id: pdppSafeText.min(1).max(2048),
    session_id: uuidSchema,
    parent_uuid: uuidSchema.nullable(),
    event_type: stringMaxSchema(64),
    hook_name: stringMaxSchema(256),
    tool_use_id: stringMaxSchema(256),
    content_preview: z
        .string()
        .max(PDPP_PREVIEW_MAX_CHARS + 1)
        .refine((val) => {
        const result = safeTextPreview(val, PDPP_PREVIEW_MAX_CHARS);
        return result.kind === "text" || result.kind === "empty";
    }, "content_preview contains forbidden control characters")
        .nullable(),
    content_binary_reason: pdppSafeText.max(200).nullable().optional(),
    content_bytes: z.number().int().min(0).nullable(),
    timestamp: isoDateTimeSchema,
});
export const skillsSchema = z.object({
    id: pdppSafeText,
    name: stringMaxSchema(256),
    description: stringMaxSchema(2048),
    source: stringMaxSchema(64),
    path: pathSchema,
    content: pdppSafeText.max(10_000_000).nullable(),
    frontmatter: z.record(z.string(), z.unknown()).nullable(),
    mtime_epoch: z.number().nullable(),
});
export const memoryNotesSchema = z.object({
    id: pdppSafeText,
    project_path: pdppSafeText,
    note_path: pdppSafeText,
    name: stringMaxSchema(256),
    description: stringMaxSchema(2048),
    path: pathSchema,
    content: pdppSafeText.max(10_000_000).nullable(),
    frontmatter: z.record(z.string(), z.unknown()).nullable(),
    mtime_epoch: z.number().nullable(),
});
export const slashCommandsSchema = z.object({
    id: pdppSafeText,
    name: stringMaxSchema(256),
    description: stringMaxSchema(2048),
    path: pathSchema,
    content: pdppSafeText.max(10_000_000).nullable(),
    frontmatter: z.record(z.string(), z.unknown()).nullable(),
    mtime_epoch: z.number().nullable(),
});
const inventoryClassificationSchema = z.enum(["inventory_only", "defer"]);
const inventoryTypeSchema = z.enum(["directory", "file", "missing", "other"]);
const coverageStatusSchema = z.enum(["collected", "inventory_only", "excluded", "deferred", "missing", "unsupported"]);
export const inventorySchema = z.object({
    id: pdppSafeText,
    store: pdppSafeText,
    relative_path: pdppSafeText.max(2048),
    path_hash: z.string().regex(/^[a-f0-9]{64}$/),
    type: inventoryTypeSchema,
    size_bytes: z.number().int().min(0).nullable(),
    mtime_epoch: z.number().int().min(0).nullable(),
    classification: inventoryClassificationSchema,
    reason: pdppSafeText.max(512),
});
export const coverageDiagnosticsSchema = z.object({
    id: pdppSafeText,
    store: pdppSafeText,
    stream: pdppSafeText.nullable(),
    status: coverageStatusSchema,
    reason: pdppSafeText.max(512),
});
export const SCHEMAS = {
    sessions: sessionsSchema,
    messages: messagesSchema,
    attachments: attachmentsSchema,
    skills: skillsSchema,
    memory_notes: memoryNotesSchema,
    slash_commands: slashCommandsSchema,
    file_history: inventorySchema,
    debug_artifacts: inventorySchema,
    downloads: inventorySchema,
    cache_inventory: inventorySchema,
    backup_inventory: inventorySchema,
    config_inventory: inventorySchema,
    coverage_diagnostics: coverageDiagnosticsSchema,
};
export const validateRecord = makeValidateRecord(SCHEMAS);
