import json, os, unittest
import yaml
import render

PARTIES = ["bi", "bank-a", "bank-b", "bank-c"]


def by_kind(objs):
    out = {}
    for o in objs:
        out.setdefault(o["kind"], []).append(o)
    return out


class Render(unittest.TestCase):
    def test_objects_and_custody(self):
        for p in PARTIES:
            k = by_kind(render.render(p))
            self.assertEqual({a: len(b) for a, b in k.items()}, {"ConfigMap": 2, "Service": 2, "Deployment": 1}, p)
            self.assertNotIn("Secret", k, "keys are a custody step, never rendered")
            self.assertNotIn("NetworkPolicy", k)
            for o in sum(k.values(), []):
                self.assertEqual(o["metadata"]["namespace"], f"fabricx-{p}")

    def test_node_ports_are_distinct_and_in_the_reserved_block(self):
        ports = [by_kind(render.render(p))["Service"][1]["spec"]["ports"][0]["nodePort"] for p in PARTIES]
        self.assertEqual(ports, [31460, 31461, 31462, 31463])

    def test_upstream_is_the_partys_own_token_service(self):
        want = {"bi": "token-issuer-v2.fabricx-bi", "bank-a": "token-owner-v2.fabricx-bank-a", "bank-b": "token-owner-v2.fabricx-bank-b", "bank-c": "token-owner-v2.fabricx-bank-c"}
        for p in PARTIES:
            cfg = yaml.safe_load(by_kind(render.render(p))["ConfigMap"][0]["data"]["envoy.yaml"])
            token = next(c for c in cfg["static_resources"]["clusters"] if c["name"] == "token")
            addr = token["load_assignment"]["endpoints"][0]["lb_endpoints"][0]["endpoint"]["address"]["socket_address"]
            self.assertEqual((addr["address"], addr["port_value"]), (want[p] + ".svc.cluster.local", 9440))
            ctx = token["transport_socket"]["typed_config"]
            self.assertEqual(ctx["sni"], addr["address"])
            self.assertEqual(ctx["common_tls_context"]["validation_context"]["match_typed_subject_alt_names"][0]["matcher"]["exact"], addr["address"])

    def test_downstream_requires_a_client_cert_and_asks_opa_with_the_body(self):
        cfg = yaml.safe_load(by_kind(render.render("bank-a"))["ConfigMap"][0]["data"]["envoy.yaml"])
        chain = cfg["static_resources"]["listeners"][0]["filter_chains"][0]
        self.assertTrue(chain["transport_socket"]["typed_config"]["require_client_certificate"])
        filters = chain["filters"][0]["typed_config"]["http_filters"]
        self.assertEqual([f["name"] for f in filters], ["envoy.filters.http.ext_authz", "envoy.filters.http.router"])
        authz = filters[0]["typed_config"]
        self.assertFalse(authz["failure_mode_allow"])
        self.assertEqual(authz["with_request_body"]["max_request_bytes"], 65536)
        hcm = chain["filters"][0]["typed_config"]
        self.assertIs(hcm["normalize_path"], True)  # OPA must see the path envoy forwards
        self.assertIs(hcm["merge_slashes"], True)

    def test_policy_data_names_the_party(self):
        want = {"bi": ("issuer", False), "bank-a": ("owner", True), "bank-b": ("owner", False), "bank-c": ("owner", False)}
        for p in PARTIES:
            opa = by_kind(render.render(p))["ConfigMap"][1]["data"]
            self.assertEqual(json.loads(opa["data.json"])["fxa_party"], {"org": p, "role": want[p][0], "buyer": want[p][1]})
            with open(os.path.join(render.HERE, "policy.rego")) as f:
                self.assertEqual(opa["policy.rego"], f.read())

    def test_every_mounted_volume_exists_and_secrets_are_named_after_the_gateway(self):
        for p in PARTIES:
            dep = by_kind(render.render(p))["Deployment"][0]
            spec = dep["spec"]["template"]["spec"]
            vols = {v["name"]: v for v in spec["volumes"]}
            for c in spec["containers"]:
                for m in c["volumeMounts"]:
                    self.assertIn(m["name"], vols)
                self.assertTrue(c["securityContext"]["readOnlyRootFilesystem"])
            n = render.PARTY_N[p]
            self.assertEqual(sorted(v["secret"]["secretName"] for v in vols.values() if "secret" in v),
                             sorted(f"fxa-gw-{n}-{s}" for s in ("server", "client-ca", "operator", "upstream-ca")))

    def test_images_can_be_pinned(self):
        dep = by_kind(render.render("bi", "e/e@sha256:1", "o/o@sha256:2"))["Deployment"][0]
        self.assertEqual([c["image"] for c in dep["spec"]["template"]["spec"]["containers"]], ["e/e@sha256:1", "o/o@sha256:2"])

    def test_defaults_are_pinned_and_tag_only_images_are_refused(self):
        dep = by_kind(render.render("bi"))["Deployment"][0]
        for c in dep["spec"]["template"]["spec"]["containers"]:
            self.assertRegex(c["image"], r"@sha256:[0-9a-f]{64}$")
        for args in (("envoyproxy/envoy:v1.38.9", render.OPA_IMAGE), (render.ENVOY_IMAGE, "openpolicyagent/opa:1.21.1-envoy-1-static")):
            with self.assertRaises(SystemExit):
                render.render("bi", *args)


if __name__ == "__main__":
    unittest.main()
