#!/usr/bin/env python3
"""Offline checks of .github/workflows/{image,publish}.yml and deploy/ci/image-checks.sh (in-cluster Lensa image, public repo rules). Usage: check.py <deploy/ci dir>."""
import os, re, stat, subprocess, sys, tempfile, yaml

here = os.path.abspath(sys.argv[1])
root = os.path.dirname(os.path.dirname(here))
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)

def wf(name):
    with open(f"{root}/.github/workflows/{name}") as f:
        return yaml.safe_load(f)

pub, img = wf("publish.yml"), wf("image.yml")
on = pub.get(True, pub.get("on"))
check(list(on) == ["workflow_dispatch"], "publish.yml must be manual (workflow_dispatch) only")
check(pub["permissions"] == {"contents": "read"}, "publish.yml: top-level permissions must be contents: read only")
job = pub["jobs"]["push"]
check(job["permissions"].get("packages") == "write" and job["permissions"].get("contents") == "read", "publish.yml: packages: write on the push job only")
check(not [k for k in job["permissions"] if k not in ("contents", "packages", "id-token", "attestations")], "publish.yml: unexpected job permissions")
steps = job["steps"]
names = [s.get("name") or s.get("uses", "") for s in steps]
def idx(pred):
    r = [i for i, s in enumerate(steps) if pred(s)]
    return r[0] if r else -1
for s in steps:
    if "uses" in s:
        check(re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", s["uses"]) is not None, f"action not pinned by commit sha: {s['uses']}")
build = idx(lambda s: s.get("id") == "build")
check(build >= 0, "publish.yml: no step with id build")
if build >= 0:
    b = steps[build]
    check(b["uses"].startswith("docker/build-push-action@"), "build must be docker/build-push-action (buildx), not docker build/push")
    w = b["with"]
    check(w.get("push") is True, "build step must push")
    check(w.get("sbom") is True, "build step must attach an SBOM")
    check(str(w.get("provenance")) == "mode=max", "build step must attach provenance mode=max")
    tags = str(w.get("tags"))
    check("ghcr.io/${{ github.repository_owner }}/rd-lensa-frontend:incluster-sha-${{ github.sha }}" in tags.replace("\n", ""), "tag must be incluster-sha-<sha> under the EXISTING package rd-lensa-frontend")
    check("NODE_IMAGE=${{ steps.base.outputs.image }}" in str(w.get("build-args")), "base image must be passed pinned by digest (build-args NODE_IMAGE)")
check(idx(lambda s: "docker/setup-buildx-action@" in s.get("uses", "")) in range(0, max(build, 1)), "setup-buildx must come before the build")
local = idx(lambda s: s.get("with", {}).get("load") is True)
check(0 <= local < build, "a local (load: true, not pushed) build with the image checks must come BEFORE the push")
if local >= 0:
    check(steps[local]["with"].get("push") is False, "the local build must not push")
chk = [i for i, s in enumerate(steps) if "deploy/ci/image-checks.sh" in s.get("run", "")]
check(len(chk) >= 2, "image-checks.sh must run on the local build AND on the pulled digest (pull test)")
if chk:
    check(chk[0] < build < chk[-1], "image checks: one before the push, the pull test after it")
vis = idx(lambda s: "assert-package-private.sh" in s.get("run", ""))
check(vis > build >= 0, "the anonymous private-package assert (.github/scripts/assert-package-private.sh) must come right after the push")
if vis >= 0:
    r = steps[vis]["run"]
    check("set -o pipefail" in r, "assert step must set pipefail (so | tee cannot hide a failure)")
    check('"${{ github.repository }}"' in r and "${{ steps.build.outputs.digest }}" in r, "assert must test the repository package at the pushed DIGEST")
att = idx(lambda s: "attest-build-provenance" in s.get("uses", ""))
check(any("test-assert-package-private.sh" in x.get("run", "") for x in wf("ci.yml")["jobs"]["test"]["steps"]) and any("deploy/ci/test.sh" in x.get("run", "") for x in wf("ci.yml")["jobs"]["test"]["steps"]), "ci.yml must run both the assert test and deploy/ci/test.sh")
check(att > build, "attest-build-provenance must come after the push")
if att >= 0:
    check("private == false" in steps[att].get("if", ""), "attest only when the repository is public")
    check(steps[att]["with"].get("push-to-registry") is True, "attestation must be pushed to the registry")
check("digest" in job.get("outputs", {}) and "steps.build.outputs.digest" in str(job["outputs"]["digest"]), "the push job must expose the digest as a job output")
pull = idx(lambda s: "docker pull" in s.get("run", ""))
check(pull > build, "pull test: docker pull of the pushed digest after the push")
if pull >= 0:
    check("@${{ steps.build.outputs.digest }}" in steps[pull]["run"], "pull test must pull by DIGEST, not by tag")
for s in steps:
    run = s.get("run", "")
    check(not re.search(r"docker build(?!x)|docker push", run), f"plain docker build/push step: {s.get('name')}")
    check("set -x" not in run and "printenv" not in run and "env |" not in run, f"log-leaking command in step {s.get('name')}")
    check(not re.search(r"echo[^\n]*secrets\.", run), f"echo of a secret in {s.get('name')}")
check("secrets.GITHUB_TOKEN" in str(steps), "ghcr login uses the workflow token")
# image.yml (PR check) shares the same checks and never pushes
check(img["jobs"]["build"]["permissions"] if "permissions" in img["jobs"]["build"] else True, "")
check(any("deploy/ci/image-checks.sh" in s.get("run", "") for s in img["jobs"]["build"]["steps"]), "image.yml must use deploy/ci/image-checks.sh")
check("push: true" not in open(f"{root}/.github/workflows/image.yml").read(), "image.yml must not push")
check("deploy/ci/**" in img[True]["pull_request"]["paths"], "image.yml must run when deploy/ci changes")

# runtime stage: npm/npx/corepack are not needed (CMD is tsx) and carry config docs that look like key material to the PEM scan; removed as root before USER
df = open(f"{root}/Dockerfile").read()
rt = df[df.index("AS runtime"):]
check(re.search(r"rm -rf /usr/local/lib/node_modules/npm\b.*corepack.*/usr/local/bin/npm\b.*npx.*corepack", rt, re.S) is not None
      and rt.index("/usr/local/lib/node_modules") < rt.index("USER 10001"), "Dockerfile runtime stage must remove npm, npx and corepack as root before USER 10001")
check("tsx" in rt.split("CMD")[-1] and "npm" not in rt.split("CMD")[-1], "runtime CMD must not use npm")
check("npm npx corepack" in open(f"{here}/image-checks.sh").read(), "image-checks.sh must fail when npm/npx/corepack are in the image")
pl = [s for s in steps if "Pull test" in s.get("name", "")]
check(pl and "docker image inspect" in pl[0]["run"] and "{{.Id}}" in pl[0]["run"] and "GITHUB_STEP_SUMMARY" in pl[0]["run"], "the pull test must print the pulled imageID (to the log and the summary) so the deployed digest can be matched")
check(re.search(r"/opt/yarn\S*", rt) and "/usr/local/bin/yarn" in rt and "/root/.npm" in rt, "runtime stage must also drop yarn and the package-manager caches (~/.npm)")
check("npm npx corepack yarn yarnpkg pnpm" in open(f"{here}/image-checks.sh").read(), "image-checks.sh must fail on yarn/pnpm too")
check(pl and "set -euo pipefail" in pl[0]["run"], "the pull test must be fail-closed (set -euo pipefail: any pull error is exit 1)")

# ---- image-checks.sh behaviour with a docker shim (no docker, no network)
script = f"{here}/image-checks.sh"
check(os.stat(script).st_mode & stat.S_IXUSR, "image-checks.sh must be executable")
SHIM = r'''#!/usr/bin/env bash
# fake docker: behaviour from env FAKE_USER, FAKE_NAMES, FAKE_HITS, FAKE_HEALTH
case "$1" in
  image) echo "${FAKE_USER:-10001:10001}" ;;
  run) if [[ "$*" == *"grep -rIl"* ]]; then printf '%s' "${FAKE_HITS:-}";
       elif [[ "$*" == *"-d "* || "$2" == "-d" ]]; then echo cid;
       else if [[ -n "${FAKE_NAMES:-}" ]]; then echo "$FAKE_NAMES"; exit 1; fi; fi ;;
  exec) [[ "${FAKE_HEALTH:-ok}" == ok ]] && exit 0 || exit 1 ;;
  rm|logs) exit 0 ;;
esac
'''
with tempfile.TemporaryDirectory() as d:
    open(f"{d}/docker", "w").write(SHIM); os.chmod(f"{d}/docker", 0o755)
    allow = f"{d}/allow.txt"; open(allow, "w").write("# none\n")
    def run(env=None, args=()):
        e = {**os.environ, "PATH": f"{d}:{os.environ['PATH']}", "KEY_SCAN_ALLOW": allow, "HEALTH_WAIT": "0", **(env or {})}
        return subprocess.run([script, "img:test", *args], capture_output=True, text=True, env=e, timeout=60)
    ok = run(args=("--no-health",))
    check(ok.returncode == 0, f"clean image should pass: {ok.stdout[-200:]}{ok.stderr[-200:]}")
    check(run({"FAKE_USER": "0:0"}, ("--no-health",)).returncode != 0, "root image must fail")
    check(run({"FAKE_NAMES": "/app/x/server.key"}, ("--no-health",)).returncode != 0, "key-like file name must fail")
    hit = "/usr/lib/x/fixture.pem " + "ab" * 32 + "\n"
    r = run({"FAKE_HITS": hit}, ("--no-health",))
    check(r.returncode != 0 and "fixture.pem" in r.stdout, "an unlisted PEM private key hit must fail and name the path")
    check("BEGIN" not in r.stdout + r.stderr, "the scan must never print key content")
    open(allow, "w").write("# allowed with a reason\n" + hit)
    check(run({"FAKE_HITS": hit}, ("--no-health",)).returncode == 0, "an allow-listed hit (path + sha256) must pass")
    check(run({"FAKE_HITS": "/usr/lib/x/fixture.pem " + "cd" * 32 + "\n"}, ("--no-health",)).returncode != 0, "same path with another sha256 must fail")
    check(run({"FAKE_HEALTH": "bad"}).returncode != 0, "a container that never answers /api/health must fail")
    check(run().returncode == 0, "healthy container must pass")

if fails:
    print("FAIL:\n  " + "\n  ".join(fails)); sys.exit(1)
print("deploy/ci: all assertions hold")
