-- @terminator: one
SELECT pc.grant_id,
       pc.token_id,
       g.grant_json,
       gp.package_json
  FROM pending_consents pc
  LEFT JOIN grants g ON g.grant_id = pc.grant_id
  LEFT JOIN grant_packages gp ON gp.package_id = pc.grant_id
 WHERE pc.device_code = ?
   AND pc.status = 'approved'
   AND pc.token_id IS NOT NULL
   AND pc.grant_id IS NOT NULL
 LIMIT 1
