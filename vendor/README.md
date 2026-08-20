# Vendored cross-repo dependency tarballs (transitional)

Built via `npm pack` from PDP-Connect/data-connect @ 9155e57ae47ab145214eb10551ed2c2185d7098a
(merges pdpp preservation-fixes-0819 port PR #30: bare-specifier package
validation, iMessage fixture date fix, connector spawn tsx-resolution
hardening), from inside that repo's workspace so sibling dependencies
resolve during the prepack build. Same mechanism, same rationale, and same removal trigger
as data-connectors PR #36's vendor/ directory: pnpm/npm git+path dependencies prepare the
subpackage in isolation where its workspace sibling does not exist, so packed tarballs are
the only mechanism that installs deterministically today. Deleted when the packages publish
from data-connect. Digests: SHA256SUMS.
