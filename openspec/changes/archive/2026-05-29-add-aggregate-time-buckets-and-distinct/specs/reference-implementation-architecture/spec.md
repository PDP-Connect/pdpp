# reference-implementation-architecture (delta)

## MODIFIED Requirements

### Requirement: Public aggregations SHALL be manifest-declared
The reference implementation SHALL evaluate only aggregation operations and fields declared by the stream manifest. Undeclared fields, non-scalar fields, arrays, objects, blobs, and high-cardinality fields that are not explicitly declared SHALL be rejected. The declarable operations are `count`, `sum`, `min`, `max`, `group_by` (scalar fields), `group_by_time` (date or date-time fields), and `count_distinct` (scalar fields). A `group_by_time` entry SHALL reference a declared field whose schema is a `string` with `format` `date` or `date-time` (or the nullable variant). A `count_distinct` entry SHALL reference a declared top-level scalar field.

#### Scenario: Declared numeric sum is accepted
- **WHEN** a stream declares a numeric field as summable
- **AND** the caller is authorized for that field
- **THEN** the client MAY request a sum aggregation over that field

#### Scenario: Undeclared field is rejected
- **WHEN** a client requests an aggregation over a field absent from the stream's aggregation declaration
- **THEN** the reference SHALL reject the request with a clear query error

#### Scenario: Declared time-bucket field is accepted
- **WHEN** a stream declares a date or date-time field under `query.aggregations.group_by_time`
- **AND** the caller is authorized for that field
- **THEN** the client MAY request a `group_by_time` aggregation over that field

#### Scenario: Undeclared distinct field is rejected
- **WHEN** a client requests `metric=count_distinct&field=<field>` and `<field>` is absent from `query.aggregations.count_distinct`
- **THEN** the reference SHALL reject the request with a clear query error

### Requirement: Grouped aggregation results SHALL be bounded and deterministic
Grouped aggregation responses SHALL enforce a maximum bucket limit and deterministic ordering. If the request exceeds the allowed limit or requests grouping by an unsupported field, the reference SHALL reject it. A request SHALL carry at most one grouping dimension: `group_by` and `group_by_time` SHALL NOT be combined. Scalar `group_by` results SHALL be ordered by count descending, then key ascending. `group_by_time` results SHALL be ordered by bucket start ascending, with the null/unparseable bucket sorted last.

#### Scenario: Grouped count with limit
- **WHEN** a client requests `group_by=<field>&limit=N`
- **AND** `<field>` is declared groupable
- **THEN** the response SHALL contain at most `N` group buckets
- **AND** the ordering SHALL be count descending, then key ascending

#### Scenario: Two grouping dimensions are rejected
- **WHEN** a client requests both `group_by` and `group_by_time` in one call
- **THEN** the reference SHALL reject the request with an `invalid_request` query error

#### Scenario: Time-bucket grouping returns an ascending series
- **WHEN** a client requests `group_by_time=<date_field>&granularity=day`
- **AND** `<date_field>` is declared time-bucketable and authorized
- **THEN** the response SHALL contain at most `limit` buckets keyed by ISO bucket start
- **AND** the buckets SHALL be ordered by bucket start ascending

### Requirement: `rs.streams.aggregate` SHALL be operation-owned

The reference implementation SHALL serve stream-aggregate behavior through a canonical `rs.streams.aggregate` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment. The operation SHALL forward the time-bucket and distinct request parameters (`group_by_time`, `granularity`, `time_zone`, `metric=count_distinct`) to its aggregate-execution dependency unchanged, and its `query.received` data block SHALL retain `query_shape: 'stream_aggregate'` while additively carrying `group_by_time` and `granularity` alongside the existing `metric`, `field`, `group_by`, and `limit` fields.

#### Scenario: Native stream aggregate route
- **WHEN** the native reference server handles `GET /v1/streams/:stream/aggregate`
- **THEN** it SHALL execute the canonical `rs.streams.aggregate` operation for aggregate semantics

#### Scenario: Operation depends on injected capabilities
- **WHEN** the `rs.streams.aggregate` operation is implemented
- **THEN** it SHALL depend on capability-shaped source-descriptor, request-validator, and aggregate-execution dependencies

#### Scenario: Existing aggregate semantics are preserved
- **WHEN** the native `GET /v1/streams/:stream/aggregate` route is migrated to the operation
- **THEN** the public response SHALL preserve the previous semantic fields for requests that do not use the new parameters, while allowing additive response fields that are `null` or `false`
- **AND** the `query.received` data block SHALL retain `query_shape: 'stream_aggregate'` together with the previously emitted `metric`, `field`, `group_by`, and `limit` fields parsed from the request query
- **AND** the `disclosure.served` data block SHALL retain `query_shape: 'stream_aggregate'` together with `metric`, `field`, `group_by`, `filtered_record_count`, and `group_count` derived from the aggregate result
- **AND** the request validator (`validateRequestedQueryFieldParams`) SHALL continue to run before the aggregate executes

## ADDED Requirements

### Requirement: Time-bucket aggregation SHALL use calendar `date_trunc` semantics with a UTC default zone
The reference implementation SHALL support grouping a single-stream aggregation into time buckets over a declared date or date-time field via `group_by_time=<field>`. `granularity` SHALL be required when `group_by_time` is present and forbidden otherwise, and SHALL be one of `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`, computed with calendar-aware `date_trunc` semantics (weeks start Monday). An optional `time_zone` SHALL select the IANA zone used to compute bucket boundaries; when omitted the effective zone SHALL be `UTC`. The response SHALL echo the effective `time_zone`, the `group_by_time` field, and the `granularity`. Records whose time field is null or unparseable SHALL be collected into a single bucket with `key: null` and SHALL NOT be silently dropped.

#### Scenario: Day buckets in the default zone
- **WHEN** a client requests `group_by_time=<date_field>&granularity=day` without `time_zone`
- **THEN** the response SHALL report `time_zone: "UTC"`, `granularity: "day"`, and `group_by_time: "<date_field>"`
- **AND** each bucket key SHALL be the ISO start of a UTC day with the count of records in that day

#### Scenario: Explicit time zone shifts bucket boundaries
- **WHEN** a client requests `group_by_time=<date_field>&granularity=day&time_zone=America/New_York`
- **THEN** the response SHALL report `time_zone: "America/New_York"`
- **AND** bucket boundaries SHALL be computed in that zone

#### Scenario: Missing or invalid granularity is rejected
- **WHEN** a client requests `group_by_time=<date_field>` without `granularity`, or with a `granularity` outside the supported set, or supplies `granularity` without `group_by_time`
- **THEN** the reference SHALL reject the request with an `invalid_request` query error

#### Scenario: Null time values bucket explicitly
- **WHEN** a `group_by_time` aggregation includes records whose time field is null or unparseable
- **THEN** those records SHALL appear in a single bucket with `key: null`
- **AND** they SHALL NOT be omitted from the response

### Requirement: `count_distinct` SHALL count distinct non-null values exactly in the reference floor
The reference implementation SHALL support a `count_distinct` metric that requires a manifest-declared, grant-authorized `field` and returns the number of distinct non-null values of that field across the filtered, grant-visible record set. Null values SHALL NOT be counted as a distinct value. The reference SHALL compute this exactly and SHALL report `approximate: false`. A future accelerated path MAY estimate the cardinality and SHALL then report `approximate: true`; capability metadata SHALL NOT advertise `count_distinct` as approximate on a server that computes it exactly.

#### Scenario: Exact distinct over a declared field
- **WHEN** a client requests `metric=count_distinct&field=<field>` and `<field>` is declared and granted
- **THEN** the response `value` SHALL equal the number of distinct non-null values of `<field>` in the filtered set
- **AND** the response SHALL report `approximate: false`

#### Scenario: Null is not a distinct value
- **WHEN** records include null values for `<field>`
- **THEN** the null value SHALL NOT contribute to the `count_distinct` result

### Requirement: The aggregate response SHALL carry additive time-bucket and distinct fields
The public aggregation response SHALL include the additive fields `group_by_time`, `granularity`, `time_zone`, and `approximate`. For non-time, non-distinct aggregations these fields SHALL be `null`/`false` so existing response payloads remain compatible. `group_by_time` and `granularity` SHALL be populated only for time-bucket groupings; `time_zone` SHALL be the echoed effective zone for time-bucket groupings; `approximate` SHALL reflect whether the reported metric is an estimate.

#### Scenario: Scalar aggregation omits time-bucket meaning
- **WHEN** a client requests a `count`, `sum`, `min`, `max`, or scalar `group_by` aggregation
- **THEN** `group_by_time` and `granularity` SHALL be `null`
- **AND** `approximate` SHALL be `false`

### Requirement: Aggregate capability discovery SHALL advertise time-bucket and distinct support
`GET /v1/schema` and stream metadata SHALL advertise the new aggregation capabilities. The stream `query.aggregations` block SHALL surface `group_by_time` and `count_distinct` declared field lists. The per-field `aggregation` descriptor SHALL include `group_by_time` and `count_distinct` `{declared, usable}` flags consistent with the existing `sum`/`min`/`max`/`group_by` flags. Capability metadata SHALL NOT over-promise: a field is `usable` for a capability only when it is declared and authorized under the caller's grant.

#### Scenario: Time-bucketable field advertises group_by_time
- **WHEN** a caller reads stream metadata for a stream that declares a date field under `query.aggregations.group_by_time`
- **AND** the caller is authorized for that field
- **THEN** the field's `aggregation.group_by_time` SHALL report `declared: true, usable: true`

#### Scenario: Undeclared distinct field advertises unusable
- **WHEN** a field is not listed under `query.aggregations.count_distinct`
- **THEN** the field's `aggregation.count_distinct` SHALL report `declared: false, usable: false`

### Requirement: The MCP aggregate tool SHALL mirror the canonical aggregate contract
The reference MCP server SHALL expose an `aggregate` tool that forwards `metric`, `field`, `group_by`, `group_by_time`, `granularity`, `time_zone`, `limit`, `filter`, and `connection_id` to `GET /v1/streams/{stream}/aggregate` and mirrors the resource server response body into `structuredContent`. The tool input schema SHALL encode the metric set (`count`, `sum`, `min`, `max`, `count_distinct`) and the granularity set, and SHALL document the single grouping dimension rule. The tool SHALL forward supported arguments verbatim and SHALL NOT silently drop an argument the resource server would reject, nor describe parameters the resource server does not support.

#### Scenario: Tool forwards a time-bucket aggregation
- **WHEN** an MCP client calls `aggregate` with `stream`, `metric=count`, `group_by_time`, and `granularity`
- **THEN** the tool SHALL issue the corresponding `GET /v1/streams/{stream}/aggregate` request
- **AND** the resource server aggregation body SHALL be returned in `structuredContent.data`

#### Scenario: Tool preserves a resource server rejection
- **WHEN** an MCP client calls `aggregate` with a request the resource server rejects (for example two grouping dimensions)
- **THEN** the tool SHALL surface the resource server error envelope rather than silently succeeding
