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

# entry option b
b = docs(["base"], {**GW, "LENSA_ENTRY": "b"})
check({d["metadata"]["name"] for d in of(b, "NetworkPolicy")} == np | {"allow-ingress-entry"}, "entry=b adds exactly allow-ingress-entry")
ing = name(b, "NetworkPolicy", "allow-ingress-entry")["spec"]
check(ing["policyTypes"] == ["Ingress"] and ing["ingress"] == [{"from": [{"ipBlock": {"cidr": "100.64.0.0/10"}}], "ports": [{"protocol": "TCP", "port": 8790}]}], f"allow-ingress-entry: {ing}")
check({d["metadata"]["name"] for d in of(b, "ServiceAccount")} == {"lensa", "lensa-admin"}, "entry=b: no lensa-access SA")
check(run(["base"], {**GW, "LENSA_ENTRY": "x"}).returncode != 0, "LENSA_ENTRY other than a|b is refused")

# ---- volume (S4b)
vol = docs(["volume"])
pvc = name(vol, "PersistentVolumeClaim", "lensa-state")
check(pvc["spec"].get("storageClassName") == "rd-retain-essd" and pvc["spec"]["resources"]["requests"]["storage"] == "5Gi" and pvc["spec"]["accessModes"] == ["ReadWriteOnce"], f"pvc spec {pvc['spec']}")
check(len(vol) == 1, "volume renders only the PVC (Secrets are created by their owners, never rendered)")

# ---- app (S6)
check(run(["app"], {"LENSA_IMAGE": "ghcr.io/radityaaa43/rd-lensa-frontend:latest"}).returncode != 0, "app: an image without @sha256 digest is refused")
check(run(["app"], {"LENSA_IMAGE": "x@sha256:" + "ab" * 32}).returncode != 0, "app: an image outside ghcr.io/radityaaa43/ is refused")
app = docs(["app"], ENV)
cm = name(app, "ConfigMap", "lensa-env")["data"]
check(cm.get("HOST") == "0.0.0.0" and cm.get("PORT") == "8790" and cm.get("LENSA_GW_MTLS_DIR") == "/certs", f"configmap fixed keys {sorted(cm)}")
check(cm.get("LENSA_GW_PALADIN_BI") == "https://10.0.0.1:31548" and cm.get("LENSA_BESU_RPC") == "https://10.0.0.1:38545", "configmap takes the env file values")
for k in cm:
    check(not re.search(r"KEY|SECRET|TOKEN|PASSWORD|KUBECONFIG", k), f"configmap key looks secret: {k}")
for bad in ["LENSA_GW_PALADIN_BI=https://user:pw@10.0.0.1:1", "KUBECONFIG=/x", "OPA_KEYS_DIR=/x", 'LENSA_BESU_RPC=http://a"b']:
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
check(c.get("startupProbe", {}).get("httpGet") == {"path": "/api/readyz", "port": "http"} and c["startupProbe"]["failureThreshold"] >= 30, "startupProbe /api/readyz")
check(c.get("readinessProbe", {}).get("httpGet") == {"path": "/api/readyz", "port": "http"}, "readinessProbe /api/readyz")
check(c.get("livenessProbe", {}).get("httpGet") == {"path": "/api/livez", "port": "http"} and c["livenessProbe"]["failureThreshold"] >= 3, "livenessProbe /api/livez")
r = c.get("resources", {})
check(r.get("requests") == {"cpu": "250m", "memory": "512Mi"} and r.get("limits") == {"cpu": "1", "memory": "1Gi"}, f"resources {r}")
mounts = {m["mountPath"]: m for m in c.get("volumeMounts", [])}
check(set(mounts) == {"/tmp", "/app/frontend/server/state", "/certs"}, f"mounts {sorted(mounts)}")
check(mounts.get("/certs", {}).get("readOnly") is True, "/certs read-only")
vols = {v["name"]: v for v in pod.get("volumes", [])}
check(any("persistentVolumeClaim" in v and v["persistentVolumeClaim"]["claimName"] == "lensa-state" for v in vols.values()), "state volume is PVC lensa-state")
proj = [s for v in vols.values() for s in v.get("projected", {}).get("sources", [])]
got = {s["secret"]["name"]: sorted((i["key"], i["path"]) for i in s["secret"]["items"]) for s in proj}
want = {f"lensa-gw-mtls-{p.lower()}": sorted((k, f"{p}/{k}") for k in ("ca.crt", "lensa.crt", "lensa.key")) for p in ("BI", "A", "B", "C")}
check(got == want, f"projected cert Secrets {got}")
check(all(s["secret"].get("optional") is not True for s in proj), "cert Secrets are not optional: a missing party Secret must stop the pod")
check(not any("kubeconfig" in str(v).lower() or "hostPath" in v for v in vols.values()), "no kubeconfig volume, no hostPath")
na = pod.get("affinity", {}).get("nodeAffinity", {}).get("requiredDuringSchedulingIgnoredDuringExecution", {}).get("nodeSelectorTerms", [{}])[0].get("matchExpressions", [])
check(na == [{"key": "kubernetes.io/hostname", "operator": "NotIn", "values": ["member-16033-node", "member-16034-node"]}], f"nodeAffinity {na}")
svc = name(app, "Service", "lensa")
check(svc["spec"].get("type", "ClusterIP") == "ClusterIP" and svc["spec"]["ports"] == [{"name": "http", "port": 8790, "targetPort": "http", "protocol": "TCP"}] and svc["spec"]["selector"] == {"app": "lensa"}, f"service {svc['spec']}")
check(c.get("ports") == [{"name": "http", "containerPort": 8790, "protocol": "TCP"}], "container port http 8790")
for d in app:
    check(d["metadata"].get("namespace") == "rd-lensa" and d["metadata"].get("labels", {}).get("part-of") == "rd-lensa", f"app: {d['kind']}/{d['metadata']['name']} namespace/label")

allx = docs(["all"], {**GW, **ENV})
check([d["kind"] for d in allx][0] == "Namespace", "all: namespace first")
check(not any(d["kind"] == "Secret" for d in allx), "no render path ever emits a Secret")

if fails:
    print("\n".join("FAIL: " + f for f in fails)); sys.exit(1)
print("ok: all assertions hold")
