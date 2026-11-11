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
# The one patch: zeto must use the Paladin SDK build in server/vendor/paladin-sdk (it has the V1 lock calls), while noto (bond) uses the npm 1.0.0 SDK,
# as in the sibling repo where each package has its own node_modules. A relative import avoids two packages with one name in one node_modules.
grep -rl '"@lfdecentralizedtrust/paladin-sdk"' "$vendor/besu/zeto/src" | xargs sed -i 's#"@lfdecentralizedtrust/paladin-sdk"#"../../../paladin-sdk"#'

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
  echo "One patch to copied files: besu/zeto/src/*.ts import \"../../../paladin-sdk\" (server/vendor/paladin-sdk) instead of \"@lfdecentralizedtrust/paladin-sdk\"; nothing else is changed."
  echo
  echo "paladin-sdk is not a git checkout: the line above is the sha256 of the sorted per-file sha256 list of its build/ directory (sdk 0.0.0, from the Paladin source tree the nodes were built from; upstream commit not recorded there)."
  echo
  echo "Files: server/vendor/MANIFEST ($(grep -vc '^#' "$vendor/MANIFEST") entries)."
} > "$vendor/PROVENANCE.md"
echo "vendored $(grep -vc '^#' "$vendor/MANIFEST") files"
