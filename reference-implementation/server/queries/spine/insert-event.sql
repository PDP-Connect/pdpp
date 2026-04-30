-- @terminator: exec
-- Append a normalized disclosure-spine event. `event_seq` is assigned at
-- the append boundary from the current table maximum so cursor ordering is
-- stable and caller input cannot forge the sequence.
INSERT INTO spine_events(
  event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
  actor_type, actor_id, subject_type, subject_id, object_type, object_id,
  status, request_id, grant_id, run_id, source_kind, source_id, client_id, stream_id,
  token_id, interaction_id, data_json, version
) VALUES (
  @event_id,
  (SELECT COALESCE(MAX(event_seq), 0) + 1 FROM spine_events),
  @event_type, @occurred_at, @recorded_at, @scenario_id, @trace_id,
  @actor_type, @actor_id, @subject_type, @subject_id, @object_type, @object_id,
  @status, @request_id, @grant_id, @run_id, @source_kind, @source_id, @client_id, @stream_id,
  @token_id, @interaction_id, @data_json, @version
)
