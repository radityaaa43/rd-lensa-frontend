#!/usr/bin/env python3
"""Print the fxa-gw-<N> gateway of one party of the Fabric-X token v2 network (ns fabricx-bi | fabricx-bank-a|b|c). stdout only: nothing is applied, no cluster, no key read.

usage: render.py bi|bank-a|bank-b|bank-c [--envoy-image IMG] [--opa-image IMG]

Lensa --mTLS--> fxa-gw-N (envoy :8443, client certificate required; ext_authz to OPA 127.0.0.1:9191, request body included)
                  --mTLS (the party's own operator certificate)--> token-<issuer|owner>-v2:9440 of the SAME namespace.
Unlike fx-gw there is no shim: the token v2 pod already speaks REST (/test/*), so the gateway is envoy + OPA only.
Objects: ConfigMaps fxa-gw-<N>-envoy and fxa-gw-<N>-opa (policy.rego + data.json with this party's org and role), Service fxa-gw-<N> (ClusterIP 8443),
Service fxa-gw-<N>-ext (NodePort 31460+N-1, eTP Cluster: the Lensa path, like fx-gw-<N>-ext), Deployment fxa-gw-<N>.
NOT rendered (custody step, README): Secrets fxa-gw-<N>-server (tls.crt, tls.key; SAN fxa-gw-<N>), fxa-gw-<N>-client-ca (ca.crt that signs Lensa's client cert),
fxa-gw-<N>-operator (tls.crt, tls.key: the party's operator identity for the token API) and fxa-gw-<N>-upstream-ca (ca.crt that signs the token pod's server cert).
No NetworkPolicy: console-web and the FSC p2p ports use these pods too, and the namespaces have none today.
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
OPA_IMAGE = "openpolicyagent/opa:1.21.1-envoy-1-static@sha256:c1f40d815a15c4ca0ccbdf300e0a3515fccf1d30fbd92e69917ab96bad83811d"


def die(msg):
    sys.exit(f"render.py: {msg}")


def typed(t, **kw):
    return {"@type": "type.googleapis.com/envoy.extensions." + t, **kw}


def upstream_host(party):
    return f"token-{ROLE[party]}-v2.fabricx-{party}.svc.cluster.local"


def envoy_config(party):
    host = upstream_host(party)
    authz = typed("filters.http.ext_authz.v3.ExtAuthz", transport_api_version="V3", with_request_body={"max_request_bytes": 65536, "allow_partial_message": False},
                  failure_mode_allow=False, grpc_service={"envoy_grpc": {"cluster_name": "opa"}, "timeout": "3s"})
    hcm = typed("filters.network.http_connection_manager.v3.HttpConnectionManager", stat_prefix="fxa",
                normalize_path=True, merge_slashes=True,  # OPA sees the path envoy forwards: no //, no /./, no /../ left to hide in
                route_config={"virtual_hosts": [{"name": "token", "domains": ["*"], "routes": [{
                    "match": {"prefix": "/"}, "route": {"cluster": "token", "timeout": "180s"}}]}]},  # a transaction waits for finality
                http_filters=[{"name": "envoy.filters.http.ext_authz", "typed_config": authz},
                              {"name": "envoy.filters.http.router", "typed_config": typed("filters.http.router.v3.Router")}])
    downstream = typed("transport_sockets.tls.v3.DownstreamTlsContext", require_client_certificate=True, common_tls_context={
        "tls_params": {"tls_minimum_protocol_version": "TLSv1_2"},
        "tls_certificates": [{"certificate_chain": {"filename": "/mtls/tls.crt"}, "private_key": {"filename": "/mtls/tls.key"}}],
        "validation_context": {"trusted_ca": {"filename": "/client-ca/ca.crt"}}})
    upstream = typed("transport_sockets.tls.v3.UpstreamTlsContext", sni=host, common_tls_context={
        "tls_params": {"tls_minimum_protocol_version": "TLSv1_2"},
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
            {"name": "opa", "type": "STATIC", "connect_timeout": "1s", "typed_extension_protocol_options": h2,
             "load_assignment": {"cluster_name": "opa", "endpoints": [{"lb_endpoints": [{"endpoint": {"address": {"socket_address": {"address": "127.0.0.1", "port_value": 9191}}}}]}]}}]}}


def render(party, envoy_image=ENVOY_IMAGE, opa_image=OPA_IMAGE):
    for img in (envoy_image, opa_image):
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
    cm_opa = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": meta(f"{name}-opa"), "data": {"policy.rego": policy, "data.json": data}}
    svc = {"apiVersion": "v1", "kind": "Service", "metadata": meta(name), "spec": {"selector": sel, "ports": [{"name": "https", "port": 8443, "targetPort": 8443}]}}
    ext = {"apiVersion": "v1", "kind": "Service", "metadata": meta(f"{name}-ext"),
           "spec": {"type": "NodePort", "externalTrafficPolicy": "Cluster", "selector": sel, "ports": [{"name": "https", "port": 8443, "targetPort": 8443, "nodePort": 31459 + n}]}}
    secret = lambda s: {"secret": {"secretName": f"{name}-{s}"}}
    dep = {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": meta(name), "spec": {
        "replicas": 1, "selector": {"matchLabels": sel}, "template": {"metadata": {"labels": {**LABELS, **sel}}, "spec": {
            "automountServiceAccountToken": False,
            "containers": [
                {"name": "envoy", "image": envoy_image, "args": ["-c", "/config/envoy.yaml", "--log-level", "warn"], "ports": [{"containerPort": 8443}],
                 "readinessProbe": {"tcpSocket": {"port": 8443}, "periodSeconds": 10},
                 "resources": {"requests": {"cpu": "20m", "memory": "32Mi"}, "limits": {"memory": "128Mi"}}, "securityContext": SEC,
                 "volumeMounts": [{"name": v, "mountPath": f"/{v}", "readOnly": True} for v in ("config", "mtls", "client-ca", "operator", "upstream-ca")]},
                {"name": "opa", "image": opa_image,
                 "args": ["run", "--server", "--addr=127.0.0.1:8181", "--log-level=error", "--set=plugins.envoy_ext_authz_grpc.addr=127.0.0.1:9191",
                          "--set=plugins.envoy_ext_authz_grpc.path=fxa/authz/allow", "/policy/policy.rego", "/policy/data.json"],
                 "resources": {"requests": {"cpu": "20m", "memory": "64Mi"}, "limits": {"memory": "256Mi"}}, "securityContext": SEC,
                 "volumeMounts": [{"name": "policy", "mountPath": "/policy", "readOnly": True}]}],
            "volumes": [{"name": "config", "configMap": {"name": f"{name}-envoy"}}, {"name": "policy", "configMap": {"name": f"{name}-opa"}},
                        {"name": "mtls", **secret("server")}, {"name": "client-ca", **secret("client-ca")},
                        {"name": "operator", **secret("operator")}, {"name": "upstream-ca", **secret("upstream-ca")}]}}}}
    return [cm_envoy, cm_opa, svc, ext, dep]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("party", choices=list(PARTY_N))
    ap.add_argument("--envoy-image", default=ENVOY_IMAGE)
    ap.add_argument("--opa-image", default=OPA_IMAGE)
    a = ap.parse_args()
    sys.stdout.write(yaml.safe_dump_all(render(a.party, a.envoy_image, a.opa_image), sort_keys=False))


if __name__ == "__main__":
    main()
