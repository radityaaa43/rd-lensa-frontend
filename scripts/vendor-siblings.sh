#!/usr/bin/env bash
# Copy the sibling-repo files listed in server/vendor/MANIFEST into server/vendor/<repo>/ and write server/vendor/PROVENANCE.md.
#   BESU_DIR=../besu IROHA3_DIR=../iroha3 PALADIN_SDK_DIR=<paladin>/sdk/typescript scripts/vendor-siblings.sh
# Needs bash, git, cp. Reads the two sibling checkouts; never writes to them; copies no key (server/test/vendor-layout.test.ts checks).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
vendor="$here/server/vendor"
# paladin-sdk: the Paladin TypeScript SDK build the running nodes were built from (zeto V1 lock calls are not in the npm release 1.0.0).
declare -A src=( [besu]="${BESU_DIR:-$here/../besu}" [iroha3]="${IROHA3_DIR:-$here/../iroha3}" [paladin-sdk]="${PALADIN_SDK_DIR:-$HOME/eksplorasi-paladin/build-v1/paladin/sdk/typescript}" )

for repo in besu iroha3; do
  [[ -d "${src[$repo]}/.git" ]] || { echo "vendor-siblings: ${src[$repo]} is not a git checkout" >&2; exit 2; }
  git -C "${src[$repo]}" diff --quiet HEAD -- || { echo "vendor-siblings: ${src[$repo]} has uncommitted changes; the provenance commit would be wrong" >&2; exit 2; }
done
[[ -f "${src[paladin-sdk]}/package.json" ]] || { echo "vendor-siblings: ${src[paladin-sdk]} has no package.json" >&2; exit 2; }

find "$vendor" -mindepth 1 ! -name MANIFEST -delete
while read -r repo path; do
  [[ -z "${repo:-}" || "$repo" == \#* ]] && continue
  [[ -n "${src[$repo]:-}" ]] || { echo "vendor-siblings: unknown repo '$repo' in MANIFEST" >&2; exit 2; }
  mkdir -p "$vendor/$repo/$(dirname "$path")"
  cp -- "${src[$repo]}/$path" "$vendor/$repo/$path"
done < "$vendor/MANIFEST"

# The sibling packages have no "type" field, so Node and tsc read their files as CommonJS (extensionless imports, default-import interop).
# Under server/ ("type": "module") they would be read as ESM and break, so each gets a package.json stub that keeps the CommonJS scope.
printf '{ "private": true, "description": "scope stub written by scripts/vendor-siblings.sh: keeps this tree CommonJS like in the sibling repo" }\n' > "$vendor/besu/noto+pente/bond/package.json"
printf '{ "private": true, "description": "scope stub written by scripts/vendor-siblings.sh: keeps this tree CommonJS like in the sibling repo" }\n' > "$vendor/besu/zeto/package.json"
# The patch: besu/zeto/src/common.ts read the flat mTLS files (ca.crt, lensa.crt, lensa.key in LENSA_GW_MTLS_DIR) when the module is loaded, which would break
# the server as soon as that directory holds only per-party subfolders (zeto S19). Lensa builds its Paladin clients itself (src/adapters/zeto-connections.ts).
perl -0pi -e 's/const mtls = mtlsDir && \{.*?\n\};/const mtls = undefined as undefined | { ca: Buffer; cert: Buffer; key: Buffer }; \/\/ patched by scripts\/vendor-siblings.sh: Lensa builds its Paladin clients in src\/adapters\/zeto-connections.ts/s' "$vendor/besu/zeto/src/common.ts"
grep -q 'const mtls = undefined' "$vendor/besu/zeto/src/common.ts" || { echo "vendor-siblings: the common.ts mtls patch did not apply" >&2; exit 2; }
# The second patch (noto S12): besu/noto+pente/common/src/config.ts read the same flat files when imported. Lensa sets those clients' options itself
# (src/adapters/noto-connections.ts, called before loadPlatform).
perl -0pi -e 's/const mtlsDir = process\.env\.LENSA_GW_MTLS_DIR;/const mtlsDir = undefined as string | undefined; \/\/ patched by scripts\/vendor-siblings.sh: Lensa builds these clients\x27 options in src\/adapters\/noto-connections.ts/' "$vendor/besu/noto+pente/common/src/config.ts"
grep -q 'const mtlsDir = undefined' "$vendor/besu/noto+pente/common/src/config.ts" || { echo "vendor-siblings: the noto common config.ts mtls patch did not apply" >&2; exit 2; }
{
  echo "# Vendored sibling code"
  echo
  echo "Copied by scripts/vendor-siblings.sh from the private sibling repos at these commits. Do not edit files here: change the sibling, then re-run the script."
  echo
  for repo in besu iroha3; do echo "$repo $(git -C "${src[$repo]}" rev-parse HEAD)"; done
  echo "paladin-sdk $(cd "${src[paladin-sdk]}/build" && find . -type f | sort | xargs sha256sum | sha256sum | cut -d' ' -f1)"
  echo
  echo "besu/stealth-address/out/* is Foundry build output (git-ignored in besu): it is the forge build on the machine that ran this script, not a tracked file at the commit above."
  echo
  echo "Two patches to copied files: besu/zeto/src/common.ts and besu/noto+pente/common/src/config.ts no longer read the flat mTLS files at load (the mtls block / mtlsDir is replaced by undefined; Lensa builds its Paladin clients in server/src/adapters/zeto-connections.ts and noto-connections.ts). The besu/zeto and besu/noto+pente sources use the npm @lfdecentralizedtrust/paladin-sdk 1.0.0; server/vendor/paladin-sdk (the PR #1189 build) is kept only as the reference the differential tests compare Lensa-built requests with, not used at runtime. Nothing else is changed."
  echo
  echo "paladin-sdk is not a git checkout: the line above is the sha256 of the sorted per-file sha256 list of its build/ directory. Source (traced 2026-11-11): the local repo ~/eksplorasi-paladin/build-v1/paladin (origin LFDT-Paladin/paladin), sdk/typescript at local merge commit 82fbd49ce1dd866e9f73eb7a3b6832907a0181aa = upstream main 559567e38c386b8c89b1ae414fee6ce76dd3fe61 + the head of the still-open PR #1189 (28c72b76fda49d0e7c317432880f167a60da2f78), conflicts hand-resolved in scripts/abi.mjs and src/domains/zeto.ts (the other 34 tracked files equal upstream main). Not an upstream commit; no public ref can rebuild it (deviation report to lead, options pending)."
  echo
  echo "Owned file, not copied: server/src/zeto/IZetoFungible_V1.abi.json is the abi array of IZetoFungible_V1 compiled from solidity/contracts/domains/interfaces/IZetoFungible_V1.sol at the head of Paladin PR #1189 (28c72b76fda49d0e7c317432880f167a60da2f78). It is a PR-origin artifact (the file is absent at paladin v1.0.0 and at main 559567e38), the wire contract of the running fork image, NOT a zeto v0.5.1 artifact. sha256 $(sha256sum "$here/server/src/zeto/IZetoFungible_V1.abi.json" | cut -d' ' -f1)."
  echo
  echo "Files: server/vendor/MANIFEST ($(grep -vc '^#' "$vendor/MANIFEST") entries)."
} > "$vendor/PROVENANCE.md"
echo "vendored $(grep -vc '^#' "$vendor/MANIFEST") files"
