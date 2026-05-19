export function makeValidateRecord(schemas) {
    return (stream, data) => {
        const schema = schemas[stream];
        if (!schema) {
            return { ok: true, data };
        }
        const result = schema.safeParse(data);
        if (result.success) {
            return { ok: true, data: result.data };
        }
        const issues = result.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
        }));
        return { ok: false, issues };
    };
}
