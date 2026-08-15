-- @terminator: exec
-- Connection-scoped blob-content erase keyed STRICTLY on one
-- connector_instance_id (blobs.connector_instance_id is NOT NULL). Deleted
-- AFTER the target's blob_bindings in the same transaction. A content-addressed
-- blob row may be shared by bindings from another connection, so retain it
-- whenever any binding remains; otherwise SQLite's blob_bindings FK rejects the
-- terminal parent delete and the whole connection delete rolls back.
-- Spec: add-owner-connection-delete-contract.
DELETE FROM blobs
 WHERE connector_instance_id = ?
   AND NOT EXISTS (
     SELECT 1
       FROM blob_bindings
      WHERE blob_bindings.blob_id = blobs.blob_id
   )
