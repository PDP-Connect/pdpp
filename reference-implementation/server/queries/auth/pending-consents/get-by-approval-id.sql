-- @terminator: one
-- Resolve the operator-projected non-redeemable approval_id back to the
-- canonical pending_consents row. The dashboard POSTs approval_id; the
-- AS uses this to derive the live device_code internally behind the
-- existing owner-session + CSRF gate.
SELECT * FROM pending_consents WHERE approval_id = ?
