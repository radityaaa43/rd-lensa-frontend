#!/usr/bin/env python3
"""Offline check of the rendered Lensa manifests (final-design/lensa/PLAN.md S4-S6).
Usage: check.py <render.sh> <fixtures dir>. Needs PyYAML only; no cluster. Exit 0 = all assertions hold."""
import os, re, subprocess, sys, yaml

render, fx = sys.argv[1], sys.argv[2]
IMAGE = "ghcr.io/radityaaa43/rd-lensa-frontend@sha256:" + "ab" * 32
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)

def run(args, env=None):
    e = {**os.environ, **(env or {})}
    try:
        return subprocess.run([render, *args], capture_output=True, text=True, env=e)
    except FileNotFoundError as ex:
        return subprocess.CompletedProcess(args, 127, "", str(ex))

def docs(args, env=None):
    out = run(args, env)
    if out.returncode != 0:
        fails.append(f"render.sh {' '.join(args)} exited {out.returncode}: {out.stderr.strip()[:200]}")
        return []
    return [d for d in yaml.safe_load_all(out.stdout) if d]

def of(ds, kind): return [d for d in ds if d["kind"] == kind]
def name(ds, kind, n):
    m = [d for d in of(ds, kind) if d["metadata"]["name"] == n]
    check(len(m) == 1, f"{kind}/{n}: expected exactly one")
    return m[0] if m else {"metadata": {}, "spec": {}, "rules": [], "data": {}, "subjects": []}

GW = {"LENSA_GATEWAYS": os.path.join(fx, "gateways.conf")}
ENV = {"LENSA_ENV_FILE": os.path.join(fx, "lensa.env"), "LENSA_IMAGE": IMAGE}

# ---- base (S4a)
base = docs(["base"], GW)
check(bool(base), "base: nothing rendered")
ns = of(base, "Namespace")
check([n["metadata"]["name"] for n in ns] == ["rd-lensa"], "base: exactly Namespace rd-lensa")
lab = (ns or [{"metadata": {}}])[0]["metadata"].get("labels", {})
check(lab.get("part-of") == "rd-lensa" and lab.get("pod-security.kubernetes.io/enforce") == "restricted", f"base: namespace labels {lab}")
check(not of(base, "ClusterRole") and not of(base, "ClusterRoleBinding"), "base: no cluster-scoped RBAC")
for d in base:
    if d["kind"] != "Namespace":
        check(d["metadata"].get("namespace") == "rd-lensa", f"base: {d['kind']}/{d['metadata']['name']} not in rd-lensa")
np = {d["metadata"]["name"] for d in of(base, "NetworkPolicy")}
check(np == {"default-deny-all", "allow-dns-egress", "egress-party-gateways"}, f"base entry=a: netpols {sorted(np)} (3 under option A)")
check(name(base, "NetworkPolicy", "default-deny-all")["spec"] == {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]}, "default-deny-all shape")
dns = name(base, "NetworkPolicy", "allow-dns-egress")["spec"]
check(dns["policyTypes"] == ["Egress"] and sorted((p["protocol"], p["port"]) for p in dns["egress"][0]["ports"]) == [("TCP", 53), ("UDP", 53)], "allow-dns-egress: TCP+UDP 53 only")
check(dns["egress"][0]["to"][0]["namespaceSelector"]["matchLabels"] == {"kubernetes.io/metadata.name": "kube-system"}, "allow-dns-egress: kube-system only")
gw = name(base, "NetworkPolicy", "egress-party-gateways")["spec"]
check(gw["policyTypes"] == ["Egress"] and gw["podSelector"] == {"matchLabels": {"app": "lensa"}}, "egress-party-gateways: Egress for app=lensa")
rules = gw["egress"]
def find_ns(n): return [r for r in rules if r.get("to", [{}])[0].get("namespaceSelector", {}).get("matchLabels", {}).get("kubernetes.io/metadata.name") == n]
zbi = find_ns("rd-zeto-bi")
check(len(zbi) == 1 and zbi[0]["to"][0]["podSelector"] == {"matchLabels": {"app": "bank-gw"}} and [p["port"] for p in zbi[0]["ports"]] == [8548, 8545] and all(p["protocol"] == "TCP" for p in zbi[0]["ports"]), f"gateway rule rd-zeto-bi: {zbi}")
check(len(find_ns("rd-fabricx-bank-b")) == 1, "gateway rule rd-fabricx-bank-b")
ipb = [r for r in rules if "ipBlock" in r.get("to", [{}])[0]]
check(len(ipb) == 1 and ipb[0]["to"][0]["ipBlock"] == {"cidr": "203.0.113.7/32"} and [p["port"] for p in ipb[0]["ports"]] == [8548], f"bank C ipBlock rule: {ipb}")
check(len(rules) == 4, f"egress-party-gateways: 4 rules from the fixture, got {len(rules)}")
check(not any(r.get("to") is None for r in rules), "every egress rule names a destination (no allow-all)")
# bad gateways.conf is refused
for bad in ["rd-zeto-bi app=x", "rd-zeto-bi app=x notaport", "ipblock 0.0.0.0/0 443", "ipblock 10.0.0.1 443", "kube-system app=x 53"]:
    p = os.path.join(fx, "_bad.conf"); open(p, "w").write(bad + "\n")
    check(run(["base"], {"LENSA_GATEWAYS": p}).returncode != 0, f"gateways.conf line accepted but must be refused: {bad!r}")
os.remove(os.path.join(fx, "_bad.conf"))
# empty gateways: policy renders with no egress rule (deny), not with an allow-all
empty = os.path.join(fx, "_empty.conf"); open(empty, "w").write("# none\n")
e = docs(["base"], {"LENSA_GATEWAYS": empty}); os.remove(empty)
check(name(e, "NetworkPolicy", "egress-party-gateways")["spec"].get("egress", []) == [], "empty gateways.conf must render an empty egress list (deny)")

sa = {d["metadata"]["name"]: d for d in of(base, "ServiceAccount")}
check(set(sa) == {"lensa", "lensa-admin", "lensa-access"}, f"ServiceAccounts {sorted(sa)} under option A")
check(sa.get("lensa", {}).get("automountServiceAccountToken") is False, "SA lensa: automountServiceAccountToken false")
adm = name(base, "Role", "lensa-admin")["rules"]
sec = [r for r in adm if "secrets" in r["resources"]]
check(len(sec) == 1 and sorted(sec[0]["verbs"]) == ["create", "patch", "update"], "lensa-admin: secrets verbs exactly create,update,patch")
resa = {x for r in adm for x in r["resources"]}
for forb in ["pods/exec", "pods/portforward", "roles", "rolebindings", "serviceaccounts", "namespaces", "secrets/*"]:
    check(forb not in resa, f"lensa-admin must not grant {forb}")
check(all("*" not in r["resources"] + r["verbs"] + r["apiGroups"] for r in adm), "lensa-admin: no wildcards")
acc = name(base, "Role", "lensa-access")["rules"]
flat = sorted((g, r, v) for rule in acc for g in rule["apiGroups"] for r in rule["resources"] for v in rule["verbs"])
check(flat == sorted([("", "pods", "get"), ("", "pods", "list"), ("", "services", "get"), ("", "pods/portforward", "create")]), f"lensa-access rules {flat}")
rb = {d["metadata"]["name"]: d for d in of(base, "RoleBinding")}
check(set(rb) == {"lensa-admin", "lensa-access"} and all(d["subjects"][0]["namespace"] == "rd-lensa" for d in rb.values()), f"RoleBindings {sorted(rb)}")

check(not any("ingress" in d["spec"] for d in of(base, "NetworkPolicy")), "entry=a: no policy allows ingress (default-deny stands; viewers come through the API server port-forward)")
# no workload binding: the pod's SA `lensa` is the subject of no Role/RoleBinding and has no token; the human/operator SAs are the only subjects
subj = [(d["kind"], s["kind"], s["name"]) for d in of(base, "RoleBinding") + of(base, "ClusterRoleBinding") for s in d["subjects"]]
check(sorted(subj) == [("RoleBinding", "ServiceAccount", "lensa-access"), ("RoleBinding", "ServiceAccount", "lensa-admin")], f"RoleBinding subjects {subj}: the workload SA `lensa` must have none")
check(all(s[2] != "lensa" for s in subj), "workload SA `lensa` is bound to a Role")
# entry option b
b = docs(["base"], {**GW, "LENSA_ENTRY": "b"})
check({d["metadata"]["name"] for d in of(b, "NetworkPolicy")} == np | {"allow-ingress-entry"}, "entry=b adds exactly allow-ingress-entry")
ing = name(b, "NetworkPolicy", "allow-ingress-entry")["spec"]
check(ing["policyTypes"] == ["Ingress"] and ing["ingress"] == [{"from": [{"ipBlock": {"cidr": "100.64.0.0/10"}}], "ports": [{"protocol": "TCP", "port": 8790}]}], f"allow-ingress-entry: {ing}")
check({d["metadata"]["name"] for d in of(b, "ServiceAccount")} == {"lensa", "lensa-admin"}, "entry=b: no lensa-access SA")
check(all(r.get("from") for p in of(b, "NetworkPolicy") for r in p["spec"].get("ingress", [])), "entry=b: every ingress rule has a `from` (never an open ingress)")
check(run(["base"], {**GW, "LENSA_ENTRY": "x"}).returncode != 0, "LENSA_ENTRY other than a|b is refused")

# the shipped gateways.conf (S5 fills it per platform as each gateway step lands)
ship = docs(["base"])
srules = name(ship, "NetworkPolicy", "egress-party-gateways")["spec"].get("egress", [])
zeto = [r for r in srules if r["to"][0].get("namespaceSelector", {}).get("matchLabels", {}).get("kubernetes.io/metadata.name", "").startswith("rd-zeto-")]
check(sorted(r["to"][0]["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"] for r in zeto) == ["rd-zeto-bank-a", "rd-zeto-bank-b", "rd-zeto-bi"], f"shipped gateways.conf: zeto party namespaces {len(zeto)}")
check(all(r["to"][0]["podSelector"] == {"matchLabels": {"app": "bank-gw"}} and [p["port"] for p in r["ports"]] == [8548, 8545] for r in zeto), "shipped gateways.conf: zeto gateway pods app=bank-gw on 8548 (Paladin) and 8545 (Besu)")
check(not any("ipBlock" in r["to"][0] for r in srules), "shipped gateways.conf: no bank C ipBlock (a public address is supplied at apply time through LENSA_GATEWAYS, never committed)")
fxgw = {r["to"][0]["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"]: r for r in srules if r["to"][0].get("namespaceSelector", {}).get("matchLabels", {}).get("kubernetes.io/metadata.name", "").startswith("rd-fabricx-")}
check(sorted(fxgw) == ["rd-fabricx-bank-a", "rd-fabricx-bank-b", "rd-fabricx-bi"], f"shipped gateways.conf: fabricx party namespaces {sorted(fxgw)}")
for n, g in (("rd-fabricx-bi", "fx-gw-1"), ("rd-fabricx-bank-a", "fx-gw-2"), ("rd-fabricx-bank-b", "fx-gw-3")):
    r = fxgw.get(n)
    check(bool(r) and r["to"][0]["podSelector"] == {"matchLabels": {"app.kubernetes.io/name": g}} and r["ports"] == [{"protocol": "TCP", "port": 8443}], f"shipped gateways.conf: {n} gateway pod app.kubernetes.io/name={g} on 8443 only")
def party_rules(prefix): return {r["to"][0]["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"]: r for r in srules if r["to"][0].get("namespaceSelector", {}).get("matchLabels", {}).get("kubernetes.io/metadata.name", "").startswith(prefix)}
irg, stg = party_rules("rd-iroha3-"), party_rules("rd-stealth-")
check(sorted(irg) == ["rd-iroha3-bank-a", "rd-iroha3-bank-b", "rd-iroha3-bi"], f"shipped gateways.conf: iroha3 party namespaces {sorted(irg)}")
check(all(r["to"][0]["podSelector"] == {"matchLabels": {"rd-iroha3/role": "gateway"}} and r["ports"] == [{"protocol": "TCP", "port": 8443}] for r in irg.values()), "shipped gateways.conf: iroha3 gateway pods rd-iroha3/role=gateway on 8443 only (iroha, mTLS gateway)")
check(sorted(stg) == ["rd-stealth-bank-a", "rd-stealth-bank-b", "rd-stealth-bi"], f"shipped gateways.conf: stealth party namespaces {sorted(stg)}")
check(all(r["to"][0]["podSelector"] == {"matchLabels": {"app": "st-gw"}} and r["ports"] == [{"protocol": "TCP", "port": 8550}] for r in stg.values()), "shipped gateways.conf: stealth gateway pods app=st-gw on 8550 only (besu, mTLS gateway)")
# the egress union is closed: one destination per rule; a namespace is always narrowed by a pod selector; only single hosts; TCP only; never an open range
for r in srules:
    to = r.get("to", [])
    check(len(to) == 1, f"egress rule with {len(to)} destinations: one rule = one destination")
    t = to[0] if to else {}
    check(("namespaceSelector" in t) == ("podSelector" in t), f"egress rule {t}: namespace without pod selector (or pod selector alone) opens a whole namespace")
    check(set(t) <= {"namespaceSelector", "podSelector", "ipBlock"} and "except" not in t.get("ipBlock", {}), f"egress destination keys {sorted(t)}")
    if "ipBlock" in t: check(t["ipBlock"]["cidr"].endswith("/32"), f"egress ipBlock {t['ipBlock']} is not a single host")
    check(r.get("ports") and all(p["protocol"] == "TCP" and isinstance(p["port"], int) for p in r["ports"]), f"egress rule ports {r.get('ports')}: explicit TCP ports only")

# ---- volume (S4b)
vol = docs(["volume"])
pvc = name(vol, "PersistentVolumeClaim", "lensa-state")
check(pvc["spec"].get("storageClassName") == "rd-retain-essd" and pvc["spec"]["resources"]["requests"]["storage"] == "5Gi" and pvc["spec"]["accessModes"] == ["ReadWriteOnce"], f"pvc spec {pvc['spec']}")
check(len(vol) == 1, "volume renders only the PVC (Secrets are created by their owners, never rendered)")
fb = name(docs(["volume"], {"LENSA_STORAGE_CLASS": "alicloud-essd-wffc"}), "PersistentVolumeClaim", "lensa-state")
check(fb["spec"].get("storageClassName") == "alicloud-essd-wffc", "LENSA_STORAGE_CLASS overrides the class (cluster 1 runs the alicloud-essd-wffc fallback + PV patched Retain)")
for bad in ["", "Bad Class", "a/b", "x;y"]:
    if bad == "": continue
    check(run(["volume"], {"LENSA_STORAGE_CLASS": bad}).returncode != 0, f"LENSA_STORAGE_CLASS {bad!r} must be refused")

# ---- app (S6)
check(run(["app"], {"LENSA_IMAGE": "ghcr.io/radityaaa43/rd-lensa-frontend:latest"}).returncode != 0, "app: an image without @sha256 digest is refused")
check(run(["app"], {"LENSA_IMAGE": "x@sha256:" + "ab" * 32}).returncode != 0, "app: an image outside ghcr.io/radityaaa43/ is refused")
app = docs(["app"], ENV)
cm = name(app, "ConfigMap", "lensa-env")["data"]
check(cm.get("HOST") == "0.0.0.0" and cm.get("PORT") == "8790" and cm.get("LENSA_GW_MTLS_DIR") == "/certs", f"configmap fixed keys {sorted(cm)}")
check(cm.get("LENSA_IN_CLUSTER") == "1" and cm.get("LENSA_SINK_TOKENS_DIR") == "/sink-tokens" and cm.get("OPA_BIN") == "/usr/local/bin/opa", "configmap: OPA_BIN is the fixed image path (the env file cannot override it); pod mode signal LENSA_IN_CLUSTER=1 and the sink token directory /sink-tokens (server/src/incluster.ts, policy/sink.ts)")
check(cm.get("LENSA_GW_PALADIN_BI") == "https://10.0.0.1:31548" and cm.get("LENSA_BESU_RPC") == "https://10.0.0.1:38545", "configmap takes the env file values")
for k in cm:
    if k == "LENSA_SINK_TOKENS_DIR": continue  # a directory name; the tokens are mounted from Secrets
    check(not re.search(r"KEY|SECRET|TOKEN|PASSWORD|KUBECONFIG", k), f"configmap key looks secret: {k}")
for bad in ["LENSA_GW_PALADIN_BI=https://user:pw@10.0.0.1:1", "KUBECONFIG=/x", "OPA_KEYS_DIR=/x", "LENSA_IN_CLUSTER=0", "LENSA_SINK_TOKENS_DIR=/x", "OPA_BIN=/tmp/opa", "DEPLOYER_KEY=x", 'LENSA_BESU_RPC=http://a"b']:
    p = os.path.join(fx, "_bad.env"); open(p, "w").write(bad + "\n")
    check(run(["app"], {"LENSA_ENV_FILE": p, "LENSA_IMAGE": IMAGE}).returncode != 0, f"env file line accepted but must be refused: {bad!r}")
os.remove(os.path.join(fx, "_bad.env"))
dep = name(app, "Deployment", "lensa")
spec = dep["spec"]; pod = spec["template"]["spec"]; c = pod["containers"][0] if pod.get("containers") else {}
check(spec["replicas"] == 1 and spec["strategy"] == {"type": "Recreate"}, "deployment: 1 replica, Recreate")
check(c.get("image") == IMAGE, "deployment: image is the digest ref given")
check(pod.get("serviceAccountName") == "lensa" and pod.get("automountServiceAccountToken") is False, "pod: SA lensa, no token mount")
check(pod.get("imagePullSecrets") == [{"name": "ghcr-pull"}], "pod: imagePullSecrets ghcr-pull")
psc = pod.get("securityContext", {})
check(psc.get("runAsNonRoot") is True and psc.get("runAsUser") == 10001 and psc.get("fsGroup") == 10001 and psc.get("seccompProfile") == {"type": "RuntimeDefault"}, f"pod securityContext {psc}")
csc = c.get("securityContext", {})
check(csc.get("allowPrivilegeEscalation") is False and csc.get("readOnlyRootFilesystem") is True and csc.get("capabilities") == {"drop": ["ALL"]}, f"container securityContext {csc}")
check(c.get("envFrom") == [{"configMapRef": {"name": "lensa-env"}}], "container: env only from ConfigMap lensa-env")
check(not any("secret" in json_k for e in c.get("env", []) for json_k in [str(e).lower()] if "valueFrom" in e), "container: no env from a Secret (keys are mounted files)")
check(c.get("startupProbe", {}).get("httpGet") == {"path": "/api/livez", "port": "http"} and c["startupProbe"]["failureThreshold"] >= 30, "startupProbe /api/livez (it protects a slow start: an unseeded state must not kill the pod; readiness stays /api/readyz)")
check(c.get("readinessProbe", {}).get("httpGet") == {"path": "/api/readyz", "port": "http"}, "readinessProbe /api/readyz")
check(c.get("livenessProbe", {}).get("httpGet") == {"path": "/api/livez", "port": "http"} and c["livenessProbe"]["failureThreshold"] >= 3, "livenessProbe /api/livez")
r = c.get("resources", {})
check(r.get("requests") == {"cpu": "100m", "memory": "256Mi"} and r.get("limits") == {"cpu": "1", "memory": "1Gi"}, f"resources {r}")
mounts = {m["mountPath"]: m for m in c.get("volumeMounts", [])}
check(set(mounts) == {"/tmp", "/app/frontend/server/state", "/certs", "/sink-tokens"}, f"mounts {sorted(mounts)}")
check(mounts.get("/certs", {}).get("readOnly") is True and mounts.get("/sink-tokens", {}).get("readOnly") is True, "/certs and /sink-tokens read-only")
vols = {v["name"]: v for v in pod.get("volumes", [])}
check(any("persistentVolumeClaim" in v and v["persistentVolumeClaim"]["claimName"] == "lensa-state" for v in vols.values()), "state volume is PVC lensa-state")
proj = [s for v in vols.values() if v.get("name") != "sink-tokens" for s in v.get("projected", {}).get("sources", [])]
got = {s["secret"]["name"]: sorted((i["key"], i["path"]) for i in s["secret"]["items"]) for s in proj}
want = {f"lensa-gw-mtls-{p.lower()}": sorted((k, f"{p}/{k}") for k in ("ca.crt", "lensa.crt", "lensa.key")) for p in ("BI", "A", "B", "C")}
stv = [v for v in vols.values() if v.get("name") == "sink-tokens" or mounts.get("/sink-tokens", {}).get("name") == v.get("name")]
tok = stv[0].get("projected", {}) if len(stv) == 1 else {}
tsrc = tok.get("sources", [])
tgot = {s["secret"]["name"]: [(i["key"], i["path"]) for i in s["secret"].get("items", [])] for s in tsrc}
twant = {f"lensa-sink-token-{p.lower()}": [("token", p)] for p in ("BI", "A", "B", "C")}
check(tgot == twant, f"sink token Secrets {tgot}: one per party (key token, file BI|A|B|C), never one shared Secret")
check(tok.get("defaultMode") == 0o440, f"sink token files mode {oct(tok.get('defaultMode', 0))}: 0440 (the pod group reads; server/src/policy/sink.ts pod mode accepts exactly this)")
check(all(s["secret"].get("optional") is not True for s in tsrc), "sink token Secrets are not optional: a half-configured pod must not start")
check(got == want, f"projected cert Secrets {got}")
check(all(s["secret"].get("optional") is not True for s in proj), "cert Secrets are not optional: a missing party Secret must stop the pod")
check(not any("kubeconfig" in str(v).lower() or "hostPath" in v for v in vols.values()), "no kubeconfig volume, no hostPath")
na = pod.get("affinity", {}).get("nodeAffinity", {}).get("requiredDuringSchedulingIgnoredDuringExecution", {}).get("nodeSelectorTerms", [{}])[0].get("matchExpressions", [])
check(na == [{"key": "kubernetes.io/hostname", "operator": "NotIn", "values": ["member-16033-node", "member-16034-node"]}], f"nodeAffinity {na}")
svc = name(app, "Service", "lensa")
check(svc["spec"].get("type", "ClusterIP") == "ClusterIP" and svc["spec"]["ports"] == [{"name": "http", "port": 8790, "targetPort": "http", "protocol": "TCP"}] and svc["spec"]["selector"] == {"app": "lensa", "role": "server"}, f"service {svc['spec']}")
check(c.get("ports") == [{"name": "http", "containerPort": 8790, "protocol": "TCP"}], "container port http 8790")
for d in app:
    check(d["metadata"].get("namespace") == "rd-lensa" and d["metadata"].get("labels", {}).get("part-of") == "rd-lensa", f"app: {d['kind']}/{d['metadata']['name']} namespace/label")

# ---- dryrun (5b): candidate verify Job, rendered from a candidate dir at apply time. No egress, no certs, no tokens read, never --apply.
import hashlib, io, shutil, tarfile, tempfile
def mk_candidate(extra=None, key_member=None, key_body=None, drop=None, stray=None):
    d = tempfile.mkdtemp(); expect = []
    for n in (1, 2, 3, 4):
        os.makedirs(f"{d}/node{n}")
        for k in ("bi", "bank"):
            rel = f"node{n}/{k}.tar.gz"
            if rel == drop: continue
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as t:
                for name, body in ((".manifest", b'{"revision":"r1"}'), (f"{k}/config/data.json", b'{"policy":{}}'), *([(key_member, key_body or b"x")] if key_member and rel == "node1/bi.tar.gz" else [])):
                    ti = tarfile.TarInfo(name); ti.size = len(body); t.addfile(ti, io.BytesIO(body))
            open(f"{d}/{rel}", "wb").write(buf.getvalue()); expect.append(f"{hashlib.sha256(buf.getvalue()).hexdigest()}  {rel}")
    if stray: open(f"{d}/{stray}", "w").write("x")
    ef = f"{d}.expect"; open(ef, "w").write("\n".join(expect) + "\n")
    return d, ef
cand, cexp = mk_candidate()
DRY = {"LENSA_IMAGE": IMAGE, "LENSA_CANDIDATE_DIR": cand, "LENSA_CANDIDATE_EXPECT": cexp}
dry = docs(["dryrun"], DRY)
cmc = name(dry, "ConfigMap", "lensa-candidate")
check(sorted(cmc.get("binaryData", {})) == sorted(f"node{n}_{k}.tar.gz" for n in (1, 2, 3, 4) for k in ("bi", "bank")) and "expect.sha256" in cmc.get("data", {}), f"lensa-candidate keys {sorted(cmc.get('binaryData', {}))} {sorted(cmc.get('data', {}))}")
job = name(dry, "Job", "lensa-dryrun"); jp = job["spec"]["template"]; jpod = jp["spec"]; jc = jpod["containers"][0]
check(jp["metadata"]["labels"].get("app") == "lensa-dryrun" and jp["metadata"]["labels"].get("app") != "lensa", f"dryrun pod label {jp['metadata']['labels']}: must not be app=lensa (Service lensa and egress-party-gateways must not select it)")
check(job["spec"].get("backoffLimit") == 0 and job["spec"].get("ttlSecondsAfterFinished", 0) > 0 and 0 < job["spec"].get("activeDeadlineSeconds", 0) <= 600, f"dryrun Job spec {job['spec'].get('backoffLimit')} {job['spec'].get('ttlSecondsAfterFinished')} {job['spec'].get('activeDeadlineSeconds')}: no retries, TTL, deadline")
check(jc["image"] == IMAGE and jpod.get("serviceAccountName") == "lensa" and jpod.get("automountServiceAccountToken") is False and jpod.get("restartPolicy") == "Never", "dryrun: same digest, SA lensa, no token, restartPolicy Never")
cmd = " ".join(jc.get("command", []) + jc.get("args", []))
check("policy-publish.ts" in cmd and "--candidate=/candidate" in cmd and "--expect-sha256-file=/expect/expect.sha256" in cmd, f"dryrun command {cmd}")
check("--apply" not in cmd and "--out" not in cmd, "dryrun command must not carry --apply (verify only, no sink write)")
envs = {e["name"]: e.get("value") for e in jc.get("env", [])}
check(envs.get("LENSA_IN_CLUSTER") == "1" and envs.get("LENSA_SINK_TOKENS_DIR") and not any(k in envs for k in ("OPA_KEYS_DIR", "KUBECONFIG", "OPA_BIN")) and not jc.get("envFrom"), f"dryrun env {sorted(envs)}: pod mode signal only; no key, no kubeconfig")
jcs = jc.get("securityContext", {}); jps = jpod.get("securityContext", {})
check(jcs.get("allowPrivilegeEscalation") is False and jcs.get("readOnlyRootFilesystem") is True and jcs.get("capabilities") == {"drop": ["ALL"]} and jps.get("runAsNonRoot") is True and jps.get("runAsUser") == 10001 and jps.get("seccompProfile") == {"type": "RuntimeDefault"}, "dryrun: restricted security context")
jm = {m["mountPath"]: m for m in jc.get("volumeMounts", [])}
check(set(jm) == {"/tmp", "/candidate", "/expect"} and jm["/candidate"].get("readOnly") is True and jm["/expect"].get("readOnly") is True, f"dryrun mounts {sorted(jm)}: no certs, no tokens, no state")
jv = jpod.get("volumes", [])
check(not any("secret" in v or "projected" in v or "persistentVolumeClaim" in v or "hostPath" in v for v in jv), "dryrun: no Secret, no PVC, no hostPath volume")
check(all(v.get("configMap", {}).get("defaultMode") == 0o444 for v in jv if "configMap" in v), "dryrun: candidate files 0444")
# network: nothing but default-deny and the namespace DNS policy applies to the Job pod, and no policy that selects app=lensa applies to it
check(not of(dry, "NetworkPolicy"), "dryrun renders no NetworkPolicy: the verify path makes no network call, default-deny stands")
for pol in of(base, "NetworkPolicy"):
    sel = pol["spec"]["podSelector"].get("matchLabels", {})
    if pol["metadata"]["name"] in ("default-deny-all", "allow-dns-egress"): check(sel == {}, f"{pol['metadata']['name']} must select every pod")
    else: check(sel.get("app") != "lensa-dryrun" and sel != {}, f"{pol['metadata']['name']} must not select the dryrun pod")
check(name(app, "Service", "lensa")["spec"]["selector"] == {"app": "lensa", "role": "server"}, "Service lensa selects app=lensa AND role=server (never the dryrun Job, never an egress-probe pod that carries app=lensa)")
plabels = pod_labels = dep["spec"]["template"]["metadata"]["labels"]
check(plabels.get("role") == "server" and plabels.get("app") == "lensa", f"lensa pod labels {plabels}: role=server is what the Service selects")
check(dep["spec"]["selector"] == {"matchLabels": {"app": "lensa"}}, "Deployment selector stays app=lensa (immutable once created; the template labels are a superset)")
# an egress-probe pod (app=lensa, role=egress-probe) falls under egress-party-gateways but is NOT selected by the Service
probe = {"app": "lensa", "role": "egress-probe"}
check(all(probe.get(k) == v for k, v in gw["podSelector"]["matchLabels"].items()), "egress-party-gateways still applies to a pod labelled app=lensa,role=egress-probe")
check(not all(probe.get(k) == v for k, v in name(app, "Service", "lensa")["spec"]["selector"].items()), "Service lensa must NOT select a pod labelled app=lensa,role=egress-probe")
# the candidate is public bundle sources only: render refuses key-like members, PEM key content, a stray file, a missing tar, a sha mismatch, a wrong expect file, a tag image
def refuse(why, **kw):
    d, e = mk_candidate(**kw)
    check(run(["dryrun"], {**DRY, "LENSA_CANDIDATE_DIR": d, "LENSA_CANDIDATE_EXPECT": e}).returncode != 0, f"dryrun must refuse: {why}")
    shutil.rmtree(d); os.remove(e)
refuse("a tar member with a key-like name", key_member="x/server.key")
refuse("a tar member that is a .pem", key_member="x/ca.pem")
refuse("PEM PRIVATE KEY content inside a tar", key_member="x/notes.txt", key_body=b"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n")
refuse("a stray file in the candidate dir", stray="stray.txt")
refuse("a missing tar", drop="node3/bank.tar.gz")
first = open(cexp).read().split()[0]; open(cexp, "w").write(open(cexp).read().replace(first, "0" * 64, 1))
check(run(["dryrun"], DRY).returncode != 0, "dryrun must refuse a sha256 mismatch against the expect file")
check(run(["dryrun"], {**DRY, "LENSA_IMAGE": "ghcr.io/radityaaa43/rd-lensa-frontend:latest"}).returncode != 0, "dryrun: an image without digest is refused")
check(run(["dryrun"], {"LENSA_IMAGE": IMAGE}).returncode != 0, "dryrun without a candidate dir is refused")
shutil.rmtree(cand); os.remove(cexp)

# ---- seed (state seed of the PVC; analyst condition 1): explicit file names from a staging dir, no egress, then a no-egress grep Job
import json
SEED_FILES = {"zeto.json": '{"rd":"0x%s","fromBlock":1}' % ("a" * 40), "noto.json": '{"dataDir":"/app/frontend/server/state/noto"}',
              "noto/contract-data-2026-11-12T00-00-00-000Z.json": '{"cashGroupId":"0x%s"}' % ("b" * 64), "noto/trades.jsonl": '{"tradeId":"t-1"}\n',
              "policy/bi/zeto/v1.json": '{"max_per_tx":{"RD":1}}', "policy/bi/audit.jsonl": '{"at":"x","event":"e"}\n'}
def mk_seed(extra=None, content=None, manifest_lie=None):
    d = tempfile.mkdtemp(); files = {**SEED_FILES, **(extra or {})}
    if content: files[content[0]] = content[1]
    ent = []
    for rel, body in files.items():
        os.makedirs(os.path.dirname(f"{d}/{rel}") or d, exist_ok=True); open(f"{d}/{rel}", "w").write(body)
        ent.append({"path": rel, "bytes": len(body), "sha256": hashlib.sha256(body.encode()).hexdigest() if rel != manifest_lie else "0" * 64})
    open(f"{d}/SEED-MANIFEST.json", "w").write(json.dumps({"files": ent, "notCarried": ["stealth.json", "iroha3.json", "iroha3/"]}, indent=2) + "\n")
    return d
SD = mk_seed()
sd = docs(["seed"], {"LENSA_IMAGE": IMAGE, "LENSA_SEED_DIR": SD})
scm = name(sd, "ConfigMap", "lensa-seed"); sj = name(sd, "Job", "lensa-seed"); sjp = sj["spec"]["template"]; sjs = sjp["spec"]; sjc = sjs["containers"][0]
check(len(scm.get("binaryData", {})) == len(SEED_FILES) and "SEED.sha256" in scm.get("data", {}), f"lensa-seed keys {sorted(scm.get('binaryData', {}))}")
sums = scm.get("data", {}).get("SEED.sha256", "")
check(all(hashlib.sha256(b.encode()).hexdigest() + "  " + k in sums for k, b in SEED_FILES.items()), "SEED.sha256 lists every file by path + sha256 (verified in the pod after the copy)")
cmd = " ".join(sjc.get("command", []) + sjc.get("args", []))
check(all(f"/state/{k}" in cmd for k in SEED_FILES) and "sha256sum -c" in cmd, "seed Job copies EACH file by its explicit name (never a directory) and verifies the sums")
check(not re.search(r"cp\s+-[a-zA-Z]*r|cp -R|\bcp [^;&]*/\*|rsync|tar |\*", cmd.replace("sha256sum -c", "")), f"seed Job must not copy a directory or glob: {cmd[:200]}")
check(sjp["metadata"]["labels"].get("app") == "lensa-seed" and sj["spec"].get("ttlSecondsAfterFinished", 0) > 0 and sj["spec"].get("backoffLimit") == 0 and 0 < sj["spec"].get("activeDeadlineSeconds", 0) <= 600, "seed Job: label app=lensa-seed, TTL, no retry, deadline")
check(sjs.get("automountServiceAccountToken") is False and sjs.get("serviceAccountName") == "lensa" and sjc["image"] == IMAGE, "seed Job: SA lensa no token, same digest")
sv = {v["name"]: v for v in sjs["volumes"]}
check(any(v.get("persistentVolumeClaim", {}).get("claimName") == "lensa-state" and not v["persistentVolumeClaim"].get("readOnly") for v in sv.values()) and not any("secret" in v or "projected" in v or "hostPath" in v for v in sv.values()), "seed Job: PVC lensa-state rw, no Secret, no hostPath")
aff = json.dumps(sjs.get("affinity", {}))
check("kubernetes.io/hostname" in aff and "lensa" in aff and "server" in aff, "seed Job: required pod affinity to the lensa server pod (the PVC is ReadWriteOnce: same node)")
check(not of(sd, "NetworkPolicy"), "seed renders no NetworkPolicy: no egress (default-deny stands)")
# refusals: key-named field, PEM, stealth, iroha3, a file outside the allow-list, a stray file, a manifest that lies
def seed_refuse(why, **kw):
    d = mk_seed(**kw)
    check(run(["seed"], {"LENSA_IMAGE": IMAGE, "LENSA_SEED_DIR": d}).returncode != 0, f"seed must refuse: {why}")
    shutil.rmtree(d)
seed_refuse("a key-named field", content=("zeto.json", '{"spendKey":"x"}'))
seed_refuse("a seed field", content=("noto/trades.jsonl", '{"seed":"x"}\n'))
seed_refuse("PEM content", content=("zeto.json", '{"note":"-----BEGIN PRIVATE KEY-----"}'))
seed_refuse("stealth.json", extra={"stealth.json": '{"deployed":{}}'})
seed_refuse("an iroha3 file", extra={"iroha3.json": "{}"})
seed_refuse("a client.toml", extra={"policy/bi/client.toml": "x"})
seed_refuse("a file outside the allow-list", extra={"notes.txt": "x"})
seed_refuse("a manifest that lies about a sha256", manifest_lie="zeto.json")
d = mk_seed(); os.remove(f"{d}/noto.json"); check(run(["seed"], {"LENSA_IMAGE": IMAGE, "LENSA_SEED_DIR": d}).returncode != 0, "seed must refuse a file listed in the manifest but missing"); shutil.rmtree(d)
check(run(["seed"], {"LENSA_IMAGE": IMAGE}).returncode != 0, "seed without LENSA_SEED_DIR is refused")
shutil.rmtree(SD)
# seedcheck: no-egress READ Job: the seeded PVC (ro) and the image data files contain no key material; prints names + sha256 only
sc = docs(["seedcheck"], {"LENSA_IMAGE": IMAGE}); cj = name(sc, "Job", "lensa-seedcheck"); cjs = cj["spec"]["template"]["spec"]; cjc = cjs["containers"][0]
ccmd = " ".join(cjc.get("command", []) + cjc.get("args", []))
check(all(w in ccmd for w in ("PRIVATE KEY", "privateKey", "spendKey", "viewKey", "seed", "grep", "/state")) and "grep hits: 0" in ccmd, "seedcheck greps PRIVATE KEY / privateKey / spendKey / viewKey / seed in the PVC and the image data files")
check(all(m.get("readOnly") is True for m in cjc["volumeMounts"] if m["mountPath"] == "/state") and any(v.get("persistentVolumeClaim", {}).get("readOnly") is True for v in cjs["volumes"]), "seedcheck: PVC mounted read-only")
check(cj["spec"]["template"]["metadata"]["labels"].get("app") == "lensa-seedcheck" and not of(sc, "NetworkPolicy") and cjs.get("automountServiceAccountToken") is False, "seedcheck: own label, no egress, no token")

allx = docs(["all"], {**GW, **ENV})
check([d["kind"] for d in allx][0] == "Namespace", "all: namespace first")
check(not any(d["kind"] == "Secret" for d in allx), "no render path ever emits a Secret")

if fails:
    print("\n".join("FAIL: " + f for f in fails)); sys.exit(1)
print("ok: all assertions hold")
