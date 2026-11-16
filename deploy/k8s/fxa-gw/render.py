#!/usr/bin/env python3
"""Print the fxa-gw-<N> gateway of one party of the Fabric-X token v2 network (ns fabricx-bi | fabricx-bank-a|b|c). stdout only: nothing is applied, no cluster, no key read.

usage: render.py bi|bank-a|bank-b|bank-c [--envoy-image IMG] [--opa-image IMG]

Lensa --mTLS--> fxa-gw-N (envoy :8443, client certificate required; ext_authz to OPA 127.0.0.1:9191, request body included)
                  --mTLS (the party's own operator certificate)--> token-<issuer|owner>-v2:9440 of the SAME namespace.
Unlike fx-gw there is no shim: the token v2 pod already speaks REST (/test/*), so the gateway is envoy + OPA only.
Objects: ConfigMaps fxa-gw-<N>-envoy and fxa-gw-<N>-opa (policy.rego + data.json with this party's org and role), Service fxa-gw-<N> (ClusterIP 8443),
Service fxa-gw-<N>-ext (NodePort 31460+N-1, eTP Cluster: the Lensa path, like fx-gw-<N>-ext), Deployment fxa-gw-<N>.
Kebijakan (Lensa model fabricx-adapter, its OWN OPA, independent of besu): a sink container (rd-bundle-sink) on 127.0.0.1:8081 keeps this party's signed
bundles bi and bank on PVC fxa-gw-<N>-bundle-store (rendered); OPA loads them from there and reports their status there; Lensa publishes through
https://fxa-gw-<N>/sink/... (envoy, three exact routes). Writes need both bundles' allow (policy.rego); without them every write is refused.
NOT rendered (custody step, README / secrets.sh): Secrets fxa-gw-<N>-server (tls.crt, tls.key; SAN fxa-gw-<N>), fxa-gw-<N>-client-ca (ca.crt that signs Lensa's client cert),
fxa-gw-<N>-operator (tls.crt, tls.key: the party's operator identity for the token API), fxa-gw-<N>-upstream-ca (ca.crt that signs the token pod's server cert),
fxa-gw-<N>-signing (key.pem: the party's bundle signing key), fxa-gw-<N>-verify (bi.pem and the party's own <keyid>.pem: public keys) and
fxa-gw-<N>-sink-token (token: the bearer Lensa and OPA present to the sink).
NetworkPolicies (the namespaces run default-deny-all for Ingress and Egress): fxa-gw-<N> lets Lensa (172.24.0.0/16, Jakarta: host and rd-lensa pod) in on 8443
and the gateway out to its own token pod on 9440 and to kube-dns; fxa-gw-<N>-to-token lets the gateway into the token pod on 9440. Allow-only, nothing else changes.
"""
import argparse, json, os, sys
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
PARTY_N = {"bi": 1, "bank-a": 2, "bank-b": 3, "bank-c": 4}
ROLE = {"bi": "issuer", "bank-a": "owner", "bank-b": "owner", "bank-c": "owner"}
BUYER = {"bank-a"}  # token v2 DvP: the buyer is bank-a only (policy.go ValidateDvP)
UID = 10001
LABELS = {"app.kubernetes.io/part-of": "fabricx-token-gw"}
SEC = {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}, "runAsNonRoot": True, "runAsUser": UID, "seccompProfile": {"type": "RuntimeDefault"}}  # PodSecurity restricted
# the images fx-gw runs today (imageID of pod fx-gw-1), pinned by digest
ENVOY_IMAGE = "envoyproxy/envoy:v1.38.9@sha256:b1f389c3a6148e85e9de364cb867aa2e5802153abb37ad80f1f2241d693da32a"
LENSA_POD = {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "rd-lensa"}}, "podSelector": {"matchLabels": {"app": "lensa"}}}
LENSA_CIDR = "172.24.0.0/16"  # Jakarta VPC: the Lensa host (172.24.11.235) and pod rd-lensa; NodePort traffic keeps this source or the node IP, both inside
OPA_IMAGE = "openpolicyagent/opa:1.21.1-envoy-1-static@sha256:c1f40d815a15c4ca0ccbdf300e0a3515fccf1d30fbd92e69917ab96bad83811d"
# The gateway's OWN bundle sink (Kebijakan): besu's party sink program (sink.py, vendored here byte-identical from besu 206f4aa opa/bundle-server/sink.py)
# as a separate instance per gateway with its own signing key, token and store; it never talks to besu's bundle-server or bank-gw. Public images only
# (the fabricx-* namespaces pull from ACR, not ghcr): python runs sink.py from a ConfigMap, and the opa it signs with is copied from OPA's static-debug image.
SINK_IMAGE = "python:3.12-alpine@sha256:c5ba3deef00c7758561a0f03c26f44f10589263d40e732b8748e0d1f38f6dd89"
OPA_TOOLS_IMAGE = "openpolicyagent/opa:1.21.1-static-debug@sha256:d01f4f2c4affb9c2cee511b2654ac949509747af439cc695307c245857c3f96f"  # static /opa + cp
KEYID = {"bi": "bi", "bank-a": "bank-a", "bank-b": "bank-b", "bank-c": "bank-c"}  # the key a party's sink signs with (Lensa publish.ts keyIds)
OWN_BUNDLES = {"bi": "bi,bank", "bank-a": "bank", "bank-b": "bank", "bank-c": "bank"}  # BI's sink signs bi and node 1's bank (seed bank-bi)
# Lensa reaches bank-c (SG cluster) by NodePort, and a NodePort answers only on the node that runs the pod (eTP Cluster does not forward on
# this cluster); Lensa's egress and LENSA_FXA_GW_C name 172.28.6.225, so fxa-gw-4 stays on that node.
# ponytail: one fixed node; a LoadBalancer/ingress for bank-c removes the pin.
NODE_PIN = {"bank-c": "core-06225-node"}
STORAGE_CLASS = "fabricx-essd"  # the class every fabricx-* namespace already uses (both clusters)


def die(msg):
    sys.exit(f"render.py: {msg}")


def typed(t, **kw):
    return {"@type": "type.googleapis.com/envoy.extensions." + t, **kw}


def upstream_host(party):
    return f"token-{ROLE[party]}-v2.fabricx-{party}.svc.cluster.local"


def sink_routes():
    """Lensa's publish door to this gateway's own sink: exactly the three calls Lensa makes (upload own/relayed bundle, fetch BI's signed bi, read status).
    The sink checks its bearer token on the POST; ext_authz is off on these routes (they are not token v2 calls). Any other /sink path falls to the
    main route, where the static policy refuses it, so the OPA-only routes (POST /status, /logs) stay unreachable from outside."""
    off = {"envoy.filters.http.ext_authz": typed("filters.http.ext_authz.v3.ExtAuthzPerRoute", disabled=True)}
    method = lambda m: [{"name": ":method", "string_match": {"exact": m}}]
    route = {"cluster": "sink", "timeout": "60s", "prefix_rewrite": "/"}
    return [
        {"match": {"safe_regex": {"regex": "^/sink/bundles/(bi|bank)$"}, "headers": method("POST")},
         "route": {"cluster": "sink", "timeout": "60s", "regex_rewrite": {"pattern": {"regex": "^/sink"}, "substitution": ""}}, "typed_per_filter_config": off},
        {"match": {"path": "/sink/bundles/bi/latest", "headers": method("GET")}, "route": {**route, "prefix_rewrite": "/bundles/bi/latest"}, "typed_per_filter_config": off},
        {"match": {"path": "/sink/status", "headers": method("GET")}, "route": {**route, "prefix_rewrite": "/status"}, "typed_per_filter_config": off},
    ]


def opa_config(party):
    """OPA loads this party's signed Kebijakan bundles from its own sink (127.0.0.1:8081) and reports their status there (Lensa reads it to confirm
    a publish). bi is signed by BI's key; bank by the party's own key (node 1: BI's). Verification keys come from --set-file (render args)."""
    poll = {"min_delay_seconds": 5, "max_delay_seconds": 15}
    return {
        "services": {"sink": {"url": "http://127.0.0.1:8081", "credentials": {"bearer": {"token_path": "/sink-token/token"}}}},
        "labels": {"gateway": f"fxa-gw-{PARTY_N[party]}"},
        "bundles": {"bi": {"service": "sink", "resource": "bundles/bi/latest", "polling": poll, "signing": {"keyid": "bi"}},
                    "bank": {"service": "sink", "resource": "bundles/bank/latest", "polling": poll, "signing": {"keyid": KEYID[party]}}},
        "status": {"service": "sink"},
        "plugins": {"envoy_ext_authz_grpc": {"addr": "127.0.0.1:9191", "path": "fxa/authz/result"}},
    }


def envoy_config(party):
    host = upstream_host(party)
    authz = typed("filters.http.ext_authz.v3.ExtAuthz", transport_api_version="V3", with_request_body={"max_request_bytes": 65536, "allow_partial_message": False},
                  failure_mode_allow=False, grpc_service={"envoy_grpc": {"cluster_name": "opa"}, "timeout": "3s"})
    hcm = typed("filters.network.http_connection_manager.v3.HttpConnectionManager", stat_prefix="fxa",
                normalize_path=True, merge_slashes=True,  # OPA sees the path envoy forwards: no //, no /./, no /../ left to hide in
                route_config={"virtual_hosts": [{"name": "token", "domains": ["*"], "routes": sink_routes() + [{
                    "match": {"prefix": "/"}, "route": {"cluster": "token", "timeout": "180s"},  # a transaction waits for finality
                    # the Kebijakan bundles read the node from here (bi.fxa / bank.fxa: input.attributes.contextExtensions.node)
                    "typed_per_filter_config": {"envoy.filters.http.ext_authz": typed(
                        "filters.http.ext_authz.v3.ExtAuthzPerRoute", check_settings={"context_extensions": {"node": f"node{PARTY_N[party]}", "target": "fabricx-adapter"}})}}]}]},
                http_filters=[{"name": "envoy.filters.http.ext_authz", "typed_config": authz},
                              {"name": "envoy.filters.http.router", "typed_config": typed("filters.http.router.v3.Router")}])
    downstream = typed("transport_sockets.tls.v3.DownstreamTlsContext", require_client_certificate=True, common_tls_context={
        "tls_params": {"tls_minimum_protocol_version": "TLSv1_2"},
        "tls_certificates": [{"certificate_chain": {"filename": "/mtls/tls.crt"}, "private_key": {"filename": "/mtls/tls.key"}}],
        "validation_context": {"trusted_ca": {"filename": "/client-ca/ca.crt"}}})
    upstream = typed("transport_sockets.tls.v3.UpstreamTlsContext", sni=host, common_tls_context={
        "tls_params": {"tls_minimum_protocol_version": "TLSv1_3", "tls_maximum_protocol_version": "TLSv1_3"},  # the token server accepts TLS 1.3 only
        "tls_certificates": [{"certificate_chain": {"filename": "/operator/tls.crt"}, "private_key": {"filename": "/operator/tls.key"}}],
        "validation_context": {"trusted_ca": {"filename": "/upstream-ca/ca.crt"},
                               "match_typed_subject_alt_names": [{"san_type": "DNS", "matcher": {"exact": host}}]}})
    h2 = {"envoy.extensions.upstreams.http.v3.HttpProtocolOptions": typed("upstreams.http.v3.HttpProtocolOptions", explicit_http_config={"http2_protocol_options": {}})}
    return {"static_resources": {
        "listeners": [{"name": "fxa", "address": {"socket_address": {"address": "0.0.0.0", "port_value": 8443}},
                       "filter_chains": [{"transport_socket": {"name": "envoy.transport_sockets.tls", "typed_config": downstream},
                                          "filters": [{"name": "envoy.filters.network.http_connection_manager", "typed_config": hcm}]}]}],
        "clusters": [
            {"name": "token", "type": "STRICT_DNS", "connect_timeout": "2s", "dns_lookup_family": "V4_ONLY",
             "load_assignment": {"cluster_name": "token", "endpoints": [{"lb_endpoints": [{"endpoint": {"address": {"socket_address": {"address": host, "port_value": 9440}}}}]}]},
             "transport_socket": {"name": "envoy.transport_sockets.tls", "typed_config": upstream}},
            {"name": "sink", "type": "STATIC", "connect_timeout": "1s",
             "load_assignment": {"cluster_name": "sink", "endpoints": [{"lb_endpoints": [{"endpoint": {"address": {"socket_address": {"address": "127.0.0.1", "port_value": 8081}}}}]}]}},
            {"name": "opa", "type": "STATIC", "connect_timeout": "1s", "typed_extension_protocol_options": h2,
             "load_assignment": {"cluster_name": "opa", "endpoints": [{"lb_endpoints": [{"endpoint": {"address": {"socket_address": {"address": "127.0.0.1", "port_value": 9191}}}}]}]}}]}}


def render(party, envoy_image=ENVOY_IMAGE, opa_image=OPA_IMAGE, sink_image=SINK_IMAGE):
    for img in (envoy_image, opa_image, sink_image, OPA_TOOLS_IMAGE):
        if "@sha256:" not in img:
            die(f"image {img!r} is not pinned by digest (want repo:tag@sha256:<digest>)")
    n = PARTY_N[party]
    ns, name = f"fabricx-{party}", f"fxa-gw-{n}"
    sel = {"app.kubernetes.io/name": name}
    meta = lambda nm, extra=None: {"name": nm, "namespace": ns, "labels": {**LABELS, **sel, **(extra or {})}}
    with open(os.path.join(HERE, "policy.rego")) as f:
        policy = f.read()
    data = json.dumps({"fxa_party": {"org": party, "role": ROLE[party], "buyer": party in BUYER}}, indent=2) + "\n"
    cm_envoy = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": meta(f"{name}-envoy"), "data": {"envoy.yaml": yaml.safe_dump(envoy_config(party), sort_keys=False)}}
    with open(os.path.join(HERE, "sink.py")) as f:
        sink_py = f.read()
    cm_sink = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": meta(f"{name}-sink"), "data": {"sink.py": sink_py}}
    cm_opa = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": meta(f"{name}-opa"), "data": {"policy.rego": policy, "data.json": data, "opa.yaml": yaml.safe_dump(opa_config(party), sort_keys=False)}}
    svc = {"apiVersion": "v1", "kind": "Service", "metadata": meta(name), "spec": {"selector": sel, "ports": [{"name": "https", "port": 8443, "targetPort": 8443}]}}
    ext = {"apiVersion": "v1", "kind": "Service", "metadata": meta(f"{name}-ext"),
           "spec": {"type": "NodePort", "externalTrafficPolicy": "Cluster", "selector": sel, "ports": [{"name": "https", "port": 8443, "targetPort": 8443, "nodePort": 31459 + n}]}}
    secret = lambda s: {"secret": {"secretName": f"{name}-{s}"}}
    kids = sorted({"bi", KEYID[party]})  # the keys OPA verifies the bundles with: bi always, plus this party's own
    host = upstream_host(party)
    pvc = {"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": meta(f"{name}-bundle-store"),
           "spec": {"accessModes": ["ReadWriteOnce"], "storageClassName": STORAGE_CLASS, "resources": {"requests": {"storage": "1Gi"}}}}
    dep = {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": meta(name), "spec": {
        "replicas": 1, "selector": {"matchLabels": sel},
        "strategy": {"type": "Recreate"},  # the bundle store is a ReadWriteOnce disk: the old pod lets go before the new one mounts it
        "template": {"metadata": {"labels": {**LABELS, **sel}}, "spec": {
            "automountServiceAccountToken": False,
            **({"nodeSelector": {"kubernetes.io/hostname": NODE_PIN[party]}} if party in NODE_PIN else {}),
            "securityContext": {"fsGroup": UID, "fsGroupChangePolicy": "OnRootMismatch"},  # the sink (uid 10001) writes the bundle store
            "initContainers": [{"name": "opa-tool", "image": OPA_TOOLS_IMAGE, "command": ["cp", "/opa", "/tools/opa"], "securityContext": SEC,
                                "resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "64Mi"}},
                                "volumeMounts": [{"name": "tools", "mountPath": "/tools"}]}],
            "containers": [
                {"name": "envoy", "image": envoy_image, "args": ["-c", "/config/envoy.yaml", "--log-level", "warn"], "ports": [{"containerPort": 8443}],
                 "readinessProbe": {"tcpSocket": {"port": 8443}, "periodSeconds": 10},
                 "resources": {"requests": {"cpu": "20m", "memory": "32Mi"}, "limits": {"memory": "128Mi"}}, "securityContext": SEC,
                 "volumeMounts": [{"name": v, "mountPath": f"/{v}", "readOnly": True} for v in ("config", "mtls", "client-ca", "operator", "upstream-ca")]},
                {"name": "opa", "image": opa_image,
                 "args": ["run", "--server", "--addr=127.0.0.1:8181", "--log-level=error", "--config-file=/policy/opa.yaml",
                          *[a for k in kids for a in (f"--set-file=keys.{k}.key=/verify/{k}.pem", f"--set=keys.{k}.algorithm=RS256")],
                          "/policy/policy.rego", "/policy/data.json"],
                 # bank.fxa reads today's outflow (daily_limit) from the party's own token history with the gateway's operator identity
                 "env": [{"name": "FXA_HISTORY_URL", "value": f"https://{host}:9440/test/history"}, {"name": "FXA_TLS_CERT", "value": "/operator/tls.crt"},
                         {"name": "FXA_TLS_KEY", "value": "/operator/tls.key"}, {"name": "FXA_TLS_CA", "value": "/upstream-ca/ca.crt"}],
                 "resources": {"requests": {"cpu": "20m", "memory": "64Mi"}, "limits": {"memory": "256Mi"}}, "securityContext": SEC,
                 "volumeMounts": [{"name": v, "mountPath": f"/{v}", "readOnly": True} for v in ("policy", "operator", "upstream-ca", "verify", "sink-token")]},
                {"name": "sink", "image": sink_image, "command": ["python", "-u", "/sink/sink.py", "8081"],
                 "env": [{"name": "PYTHONDONTWRITEBYTECODE", "value": "1"}, {"name": "SINK_TOKEN_FILE", "value": "/sink-token/token"},
                         {"name": "BUNDLE_STORE", "value": "/bundle-store"}, {"name": "PARTY_BUNDLE", "value": OWN_BUNDLES[party]},
                         {"name": "SIGNING_KEY_FILE", "value": "/signing/key.pem"}, {"name": "SIGNING_KEYID", "value": KEYID[party]},
                         {"name": "OPA_BIN", "value": "/tools/opa"}, {"name": "MAX_BUNDLE_BYTES", "value": "10485760"}],
                 "readinessProbe": {"tcpSocket": {"port": 8081}, "periodSeconds": 10},
                 "resources": {"requests": {"cpu": "10m", "memory": "32Mi"}, "limits": {"memory": "256Mi"}}, "securityContext": SEC,
                 "volumeMounts": [{"name": "bundle-store", "mountPath": "/bundle-store"}, {"name": "signing", "mountPath": "/signing", "readOnly": True},
                                  {"name": "sink-token", "mountPath": "/sink-token", "readOnly": True}, {"name": "tmp", "mountPath": "/tmp"},
                                  {"name": "sink-py", "mountPath": "/sink", "readOnly": True}, {"name": "tools", "mountPath": "/tools", "readOnly": True}]}],
            "volumes": [{"name": "config", "configMap": {"name": f"{name}-envoy"}}, {"name": "policy", "configMap": {"name": f"{name}-opa"}},
                        {"name": "mtls", **secret("server")}, {"name": "client-ca", **secret("client-ca")},
                        {"name": "operator", **secret("operator")}, {"name": "upstream-ca", **secret("upstream-ca")},
                        {"name": "verify", **secret("verify")}, {"name": "signing", **secret("signing")}, {"name": "sink-token", **secret("sink-token")},
                        {"name": "bundle-store", "persistentVolumeClaim": {"claimName": f"{name}-bundle-store"}},
                        {"name": "tmp", "emptyDir": {"medium": "Memory", "sizeLimit": "64Mi"}},
                        {"name": "sink-py", "configMap": {"name": f"{name}-sink"}}, {"name": "tools", "emptyDir": {"sizeLimit": "128Mi"}}]}}}}
    token = {"app": f"token-{ROLE[party]}-v2", "app.kubernetes.io/part-of": "fabricx-transfer-v2"}
    tcp = lambda port: {"port": port, "protocol": "TCP"}
    np_gw = {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": meta(name), "spec": {
        "podSelector": {"matchLabels": sel}, "policyTypes": ["Ingress", "Egress"],
        "ingress": [{"from": [{"ipBlock": {"cidr": LENSA_CIDR}}, LENSA_POD], "ports": [tcp(8443)]}],  # ipBlock: host and NodePort; LENSA_POD: in-cluster (terway eBPF does not match pod sources by ipBlock)
        "egress": [{"to": [{"podSelector": {"matchLabels": token}}], "ports": [tcp(9440)]},
                   {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}, "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}],
                    "ports": [{"port": 53, "protocol": "UDP"}, tcp(53)]}]}}
    np_token = {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": meta(f"{name}-to-token"), "spec": {
        "podSelector": {"matchLabels": token}, "policyTypes": ["Ingress"],
        "ingress": [{"from": [{"podSelector": {"matchLabels": sel}}], "ports": [tcp(9440)]}]}}
    return [cm_envoy, cm_opa, cm_sink, svc, ext, pvc, dep, np_gw, np_token]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("party", choices=list(PARTY_N))
    ap.add_argument("--envoy-image", default=ENVOY_IMAGE)
    ap.add_argument("--opa-image", default=OPA_IMAGE)
    ap.add_argument("--sink-image", default=SINK_IMAGE)
    a = ap.parse_args()
    sys.stdout.write(yaml.safe_dump_all(render(a.party, a.envoy_image, a.opa_image, a.sink_image), sort_keys=False))


if __name__ == "__main__":
    main()
