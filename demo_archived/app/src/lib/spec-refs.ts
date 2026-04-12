const BASE = 'https://pdpp.vana.com';

export interface SpecRef {
  label: string;
  url: string;
}

export const SPEC = {
  introduction:           { label: '§1 Introduction',              url: `${BASE}/spec-core#introduction` },
  selectionRequest:       { label: '§5 Selection Request',         url: `${BASE}/spec-core#selection-request` },
  aiTrainingConsent:      { label: '§5.1 AI Training Consent',     url: `${BASE}/spec-core#ai-training-consent` },
  grant:                  { label: '§6 Grant',                     url: `${BASE}/spec-core#grant` },
  accessModes:            { label: '§6.2 Access modes',            url: `${BASE}/spec-core#access-modes` },
  manifestFormat:         { label: '§7 Manifest Format',           url: `${BASE}/spec-core#manifest-format` },
  views:                  { label: '§7.3 Views',                   url: `${BASE}/spec-core#views` },
  resourceServer:         { label: '§8 Resource Server',           url: `${BASE}/spec-core#resource-server-interface` },
  listRecords:            { label: '§8.1 List records',            url: `${BASE}/spec-core#list-records` },
  streamMetadata:         { label: '§8.2 Stream metadata',         url: `${BASE}/spec-core#stream-metadata` },
  errors:                 { label: '§8.3 Errors',                  url: `${BASE}/spec-core#errors` },
  conformance:            { label: '§9 Conformance',               url: `${BASE}/spec-core#conformance` },
  dataMinimization:       { label: '§10.3 Data minimization',      url: `${BASE}/spec-core#data-minimization` },
  revocation:             { label: '§10 Revocation',               url: `${BASE}/spec-core#revocation` },
  collectionProfile:      { label: '§Collection Profile',          url: `${BASE}/spec-collection-profile` },
} as const satisfies Record<string, SpecRef>;
