#!/bin/bash
# Asserts that a ghcr.io container package is PRIVATE, from the outside: an ANONYMOUS client (no login, no token of ours) must be refused. The repositories are public, a package
# linked to a public repository can become public by accident, and an image must never be pullable by everyone. Usage: assert-package-private.sh <owner/name> <tag-or-digest>
# Private = ghcr.io refuses the anonymous token (401/403/404) or refuses/does not find the manifest with it (401/403/404). Public = the anonymous manifest read answers 200 -> exit 1.
# Anything else (no answer, 5xx) is "cannot tell" -> exit 1: the job must not pass on a guess.
set -euo pipefail
repo="${1:?owner/name}"; ref="${2:?tag or digest}"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
code=$(curl -s --max-time 30 -o "$tmp/tok.json" -w '%{http_code}' "https://ghcr.io/token?scope=repository:${repo}:pull" || true)
case "$code" in
  401|403|404) echo "package ${repo}: PRIVATE (anonymous token refused, HTTP ${code})"; exit 0 ;;
  200) ;;
  *) echo "::error::cannot tell the visibility of ${repo}: token endpoint answered HTTP ${code:-none}"; exit 1 ;;
esac
token=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/tok.json" | head -1)
[ -n "$token" ] || { echo "::error::cannot tell the visibility of ${repo}: no token in the answer"; exit 1; }
code=$(curl -s --max-time 30 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
  "https://ghcr.io/v2/${repo}/manifests/${ref}" || true)
case "$code" in
  401|403|404) echo "package ${repo}: PRIVATE (anonymous manifest read refused, HTTP ${code})"; exit 0 ;;
  200) echo "::error::package ${repo} is PUBLIC: an anonymous client can read ${ref}. Set the package visibility to private (Package settings), then run the job again."; exit 1 ;;
  *) echo "::error::cannot tell the visibility of ${repo}: manifest answered HTTP ${code:-none}"; exit 1 ;;
esac
