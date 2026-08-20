# Vendored cross-repo dependency tarballs (transitional)

Built via `npm pack` from PDP-Connect/data-connect @ 525fffa6f7756b785700219afcaaacc4492a0819
(the corrected Move R head), from inside that repo's workspace so sibling dependencies
resolve during the prepack build. Same mechanism, same rationale, and same removal trigger
as data-connectors PR #36's vendor/ directory: pnpm/npm git+path dependencies prepare the
subpackage in isolation where its workspace sibling does not exist, so packed tarballs are
the only mechanism that installs deterministically today. Deleted when the packages publish
from data-connect. Digests: SHA256SUMS.
