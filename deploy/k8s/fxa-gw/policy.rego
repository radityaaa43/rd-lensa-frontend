package fxa.authz

import rego.v1

# Policy of one fxa-gw-<N> (Lensa's door to the Fabric-X token v2 API /test/*). Envoy asks OPA for every request (ext_authz, request body included).
# data.fxa_party = {"org": "bank-a", "role": "owner" | "issuer", "buyer": true | false} comes from the party's own ConfigMap (render.py).
# The token node enforces its own rules too (policy.go); this is the gateway's allowlist in front of it: only the routes Lensa's adapter
# calls, only for this party's own organisation, no query strings, no percent-encoding.

# Kebijakan: a write also needs this party's signed bundles (bi.fxa from BI, bank.fxa from the party: server/opa-fxa, published by Lensa
# to the gateway's own sink). Missing bundles = every write refused; reads, the gate and the routes below do not depend on them.
default allow := false

p := data.fxa_party

req := input.attributes.request.http

body := json.unmarshal(req.body)

reads := {"/test/session", "/test/balance", "/test/history"}

issuer_posts := {"/test/issue", "/test/dvp-offer", "/test/dvp-settle"}

buyer_posts := {"/test/dvp-accept"}

allow if {
	route_ok
	policy_ok
}

writes := {"/test/issue", "/test/transfer", "/test/dvp-offer", "/test/dvp-accept", "/test/dvp-settle"}

write if {
	req.method == "POST"
	req.path in writes
}

policy_ok if not write

policy_ok if {
	write
	data.bi.fxa.allow == true
	data.bank.fxa.allow == true
}

# Only `allow` (a default rule: defined once the bundle is loaded). Referencing the whole package (data.bank.fxa) evaluates every rule in it,
# including bank.fxa.history (an http.send to the token history): on BI that read takes ~5 s and Envoy's 3 s ext_authz timeout refused every write.
bundles_loaded if {
	is_boolean(data.bi.fxa.allow)
	is_boolean(data.bank.fxa.allow)
}

reasons contains "Kebijakan Fabric-X (token v2) belum diterbitkan ke gateway ini" if {
	write
	not bundles_loaded
}

reasons contains r if {
	write
	some r in data.bi.fxa.reasons
}

reasons contains r if {
	write
	some r in data.bank.fxa.reasons
}

# The decision Envoy reads (plugins.envoy_ext_authz_grpc.path = fxa/authz/result): a refused write says why, so Lensa can show it.
json_403(v) := {"allowed": false, "http_status": 403, "headers": {"content-type": "application/json"}, "body": json.marshal(v)}

default result := {"allowed": false, "http_status": 403, "headers": {"content-type": "application/json"}, "body": "{\"error\":\"forbidden\"}"}

result := {"allowed": true} if allow

result := json_403({"error": "policy_denied", "reasons": sort([r | some r in reasons])}) if {
	route_ok
	not policy_ok
}

# BI's audit report by period (fxa-gw-1 routes /test/audit to the auditor node): the ONE query string allowed, two RFC 3339 UTC instants.
audit_period := `^/test/audit\?from=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z&to=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`

route_ok if {
	p.role == "issuer"
	req.method == "GET"
	regex.match(audit_period, req.path)
}

route_ok if {
	not contains(req.path, "?")
	not contains(req.path, "..")
	not contains(req.path, "%") # the adapter's ids are [A-Za-z0-9._-]; %2e%2e would pass the ".." check
	permitted
}

permitted if {
	req.method == "GET"
	req.path in reads
}

permitted if {
	req.method == "GET"
	startswith(req.path, "/test/requests/")
}

# The asset-execution gate of this party's own node: a lease of at most 120 s, or a close.
permitted if {
	req.path == "/test/asset-gate"
	req.method == "GET"
}

permitted if {
	req.path == "/test/asset-gate"
	req.method == "POST"
	body.Action == "close"
}

permitted if {
	req.path == "/test/asset-gate"
	req.method == "POST"
	body.Action == "open"
	is_number(body.TTLSeconds)
	body.TTLSeconds > 0
	body.TTLSeconds <= 120
}

permitted if {
	p.role == "owner"
	req.method == "POST"
	req.path == "/test/transfer"
	body.Sender == p.org
}

permitted if {
	p.role == "issuer"
	req.method == "POST"
	req.path in issuer_posts
}

permitted if {
	p.role == "issuer"
	req.method == "GET"
	startswith(req.path, "/test/dvp/")
}

permitted if {
	p.buyer
	req.method == "GET"
	startswith(req.path, "/test/dvp/")
}

permitted if {
	p.buyer
	req.method == "POST"
	req.path in buyer_posts
}

# BI's audit report for given transactions (read only, answered by the auditor node; the node checks the period and the ids itself).
permitted if {
	p.role == "issuer"
	req.method == "POST"
	req.path == "/test/audit"
	is_array(body.Expected)
	count(body.Expected) > 0
	count(body.Expected) <= 1000
}
