-- @terminator: exec
-- Connection-scoped attention-record erase keyed STRICTLY on one
-- connector_instance_id. Attention records carry both connector_instance_id and
-- a connection_id mirror; the connector_instance_id column is the durable
-- connection key and the one this cascade filters on. Spec:
-- add-owner-connection-delete-contract.
DELETE FROM connector_attention_records WHERE connector_instance_id = ?
