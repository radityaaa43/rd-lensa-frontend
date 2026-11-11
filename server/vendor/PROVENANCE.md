# Vendored sibling code

Copied by scripts/vendor-siblings.sh from the private sibling repos at these commits. Do not edit files here: change the sibling, then re-run the script.

besu 9890701075984aa7ccc9e27ed4eb784bf51c2189
iroha3 b273b0262d7d320ff18f00122c5d6de3b9e51266
paladin-sdk 627cb3b6d6f9fd54baf23535d57707e236fa4232d80bb251e88eef2bed2c1fbd

besu/stealth-address/out/* is Foundry build output (git-ignored in besu): it is the forge build on the machine that ran this script, not a tracked file at the commit above.

One patch to copied files: besu/zeto/src/*.ts import "../../../paladin-sdk" (server/vendor/paladin-sdk) instead of "@lfdecentralizedtrust/paladin-sdk"; nothing else is changed.

paladin-sdk is not a git checkout: the line above is the sha256 of the sorted per-file sha256 list of its build/ directory (sdk 0.0.0, from the Paladin source tree the nodes were built from; upstream commit not recorded there).

Files: server/vendor/MANIFEST (134 entries).
