package fxa.authz_test

import rego.v1

import data.fxa.authz

owner_a := {"org": "bank-a", "role": "owner", "buyer": true}

owner_b := {"org": "bank-b", "role": "owner", "buyer": false}

issuer := {"org": "bi", "role": "issuer", "buyer": false}

call(method, path, body) := {"attributes": {"request": {"http": {"method": method, "path": path, "body": body}}}}

test_owner_reads if {
	authz.allow with input as call("GET", "/test/balance", "") with data.fxa_party as owner_b
	authz.allow with input as call("GET", "/test/history", "") with data.fxa_party as owner_b
	authz.allow with input as call("GET", "/test/requests/lensa-xfer-1", "") with data.fxa_party as owner_b
}

test_owner_transfers_only_as_itself if {
	authz.allow with input as call("POST", "/test/transfer", `{"Sender":"bank-b","Recipient":"bank-c"}`) with data.fxa_party as owner_b
	not authz.allow with input as call("POST", "/test/transfer", `{"Sender":"bank-a","Recipient":"bank-c"}`) with data.fxa_party as owner_b
	not authz.allow with input as call("POST", "/test/transfer", "not json") with data.fxa_party as owner_b
}

test_owner_cannot_issue_or_settle if {
	not authz.allow with input as call("POST", "/test/issue", `{"Asset":"RupiahDigital"}`) with data.fxa_party as owner_b
	not authz.allow with input as call("POST", "/test/dvp-settle", `{"OfferID":"x"}`) with data.fxa_party as owner_b
}

test_issuer_can_issue_and_run_the_offer_side if {
	authz.allow with input as call("POST", "/test/issue", `{"Asset":"RupiahDigital"}`) with data.fxa_party as issuer
	authz.allow with input as call("POST", "/test/dvp-offer", `{"OfferID":"x"}`) with data.fxa_party as issuer
	authz.allow with input as call("POST", "/test/dvp-settle", `{"OfferID":"x"}`) with data.fxa_party as issuer
	authz.allow with input as call("GET", "/test/dvp/x", "") with data.fxa_party as issuer
	not authz.allow with input as call("POST", "/test/dvp-accept", `{"OfferID":"x"}`) with data.fxa_party as issuer
}

test_only_the_buyer_accepts if {
	authz.allow with input as call("POST", "/test/dvp-accept", `{"OfferID":"x"}`) with data.fxa_party as owner_a
	authz.allow with input as call("GET", "/test/dvp/x", "") with data.fxa_party as owner_a
	not authz.allow with input as call("POST", "/test/dvp-accept", `{"OfferID":"x"}`) with data.fxa_party as owner_b
	not authz.allow with input as call("GET", "/test/dvp/x", "") with data.fxa_party as owner_b
}

test_routes_the_adapter_does_not_call_are_denied if {
	not authz.allow with input as call("POST", "/test/dvp-cancel", `{"OfferID":"x"}`) with data.fxa_party as issuer
	not authz.allow with input as call("POST", "/test/dvp-decline", `{"OfferID":"x"}`) with data.fxa_party as owner_a
	not authz.allow with input as call("GET", "/test/dvp-offers", "") with data.fxa_party as owner_a
	not authz.allow with input as call("GET", "/test/dvp-offers", "") with data.fxa_party as issuer
}

test_asset_gate_lease_is_bounded if {
	authz.allow with input as call("POST", "/test/asset-gate", `{"Action":"open","TTLSeconds":120}`) with data.fxa_party as owner_b
	authz.allow with input as call("POST", "/test/asset-gate", `{"Action":"close","TTLSeconds":0}`) with data.fxa_party as owner_b
	not authz.allow with input as call("POST", "/test/asset-gate", `{"Action":"open","TTLSeconds":600}`) with data.fxa_party as owner_b
	not authz.allow with input as call("POST", "/test/asset-gate", `{"Action":"open"}`) with data.fxa_party as owner_b
}

test_everything_else_is_denied if {
	not authz.allow with input as call("GET", "/test/balance?x=1", "") with data.fxa_party as owner_b
	not authz.allow with input as call("GET", "/test/requests/../audit", "") with data.fxa_party as owner_b
	not authz.allow with input as call("GET", "/test/requests/%2e%2e/audit", "") with data.fxa_party as owner_b
	not authz.allow with input as call("GET", "/test/requests/%2E%2E/audit", "") with data.fxa_party as owner_b
	not authz.allow with input as call("GET", "/test/dvp/%2e%2e/audit", "") with data.fxa_party as issuer
	not authz.allow with input as call("GET", "/test/audit", "") with data.fxa_party as issuer
	not authz.allow with input as call("POST", "/test/initialize", "{}") with data.fxa_party as issuer
	not authz.allow with input as call("DELETE", "/test/balance", "") with data.fxa_party as owner_b
}
