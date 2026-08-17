# Vendored cross-repo dependency tarballs (transitional)

Built via `npm pack` from PDP-Connect/data-connect @ 48c8364c4627ee8d923f90c98de050eeaff236b3
(the corrected Move R head), from inside that repo's workspace so sibling dependencies
resolve during the prepack build. Same mechanism, same rationale, and same removal trigger
as data-connectors PR #36's vendor/ directory: pnpm/npm git+path dependencies prepare the
subpackage in isolation where its workspace sibling does not exist, so packed tarballs are
the only mechanism that installs deterministically today. Deleted when the packages publish
from data-connect. Digests: SHA256SUMS.
