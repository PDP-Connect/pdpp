-- @terminator: one
-- Resolve the operator-projected non-redeemable approval_id back to the
-- canonical owner_device_auth row. The dashboard POSTs approval_id; the
-- AS uses this to derive the live user_code internally behind the
-- existing owner-session + CSRF gate.
SELECT * FROM owner_device_auth WHERE approval_id = ?
