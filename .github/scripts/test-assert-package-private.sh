#!/bin/bash
# Test of assert-package-private.sh with a fake `curl` (no network): the assert passes ONLY when ghcr.io refuses anonymous access explicitly; a public package, a surprise status or no
# answer all fail the job (a package must never be public by accident: the repos are public, the images are not).
here="$(cd "$(dirname "$0")" && pwd)"; bad=0
t() { # name want token_status manifest_status
  local d; d=$(mktemp -d)
  cat > "$d/curl" <<SH
#!/bin/bash
# fake curl: the URL decides which scripted status is returned (-w '%{http_code}'); the token body is a fixed fake JSON
url=""; out=""; for a in "\$@"; do case "\$a" in https://*) url="\$a";; esac; done
prev=""; for a in "\$@"; do [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"; done
case "\$url" in
  *"/token?"*) [ -z "\$out" ] || echo '{"token":"fake"}' > "\$out"; printf '%s' "$3" ;;
  *"/manifests/"*) [ -z "\$out" ] || : > "\$out"; printf '%s' "$4" ;;
esac
SH
  chmod +x "$d/curl"
  ( PATH="$d:$PATH" bash "$here/assert-package-private.sh" octo/pkg sha-abc ) >/dev/null 2>&1; local rc=$?
  if { [ "$2" = pass ] && [ $rc = 0 ]; } || { [ "$2" = fail ] && [ $rc != 0 ]; }; then echo "PASS $1 (rc $rc)"; else echo "FAIL $1 (rc $rc, want $2)"; bad=1; fi
}
t "anonymous token refused (401) -> private" pass 401 000
t "anonymous token refused (403) -> private" pass 403 000
t "anonymous token refused (404) -> private" pass 404 000
t "token granted but the manifest is refused (401) -> private" pass 200 401
t "token granted but the manifest is not found (404) -> private" pass 200 404
t "token granted and the manifest is readable (200) -> PUBLIC -> fail" fail 200 200
t "no answer from the token endpoint (000) -> cannot tell -> fail" fail 000 000
t "token endpoint 500 -> cannot tell -> fail" fail 500 000
t "manifest 500 -> cannot tell -> fail" fail 200 500
exit $bad
