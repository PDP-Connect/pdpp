export function sumCountRows(rows) {
  return Array.from(rows || []).reduce((total, row) => total + Number(row?.n || 0), 0);
}

export function sqliteFieldPathCte(declaredFields, jsonPathForField) {
  const fields = Array.isArray(declaredFields) ? declaredFields : [];
  return {
    fields,
    valuesSql: fields.map(() => '(?, ?, ?)').join(', '),
    binds: fields.flatMap((field, index) => [index, field, jsonPathForField(field)]),
  };
}

export function sqliteCountIndexableTextValues({
  connectorInstanceId,
  stream,
  declaredFields,
  jsonPathForField,
  iterateDynamicSql,
}) {
  const cte = sqliteFieldPathCte(declaredFields, jsonPathForField);
  if (cte.fields.length === 0) return 0;
  // REVIEWED-DYNAMIC: declared fields are bound as VALUES rows so one grouped
  // scan can replace a loop of per-field COUNT statements.
  const rows = iterateDynamicSql(
    `WITH declared_fields(field_ordinal, field, path) AS (VALUES ${cte.valuesSql})
     SELECT declared_fields.field_ordinal, declared_fields.field, COUNT(*) AS n
     FROM declared_fields
     JOIN records
       ON records.connector_instance_id = ?
      AND records.stream = ?
      AND records.deleted = 0
      AND json_type(records.record_json, declared_fields.path) = 'text'
      AND length(json_extract(records.record_json, declared_fields.path)) > 0
     GROUP BY declared_fields.field_ordinal, declared_fields.field`,
    [...cte.binds, connectorInstanceId, stream],
  );
  return sumCountRows(rows);
}
