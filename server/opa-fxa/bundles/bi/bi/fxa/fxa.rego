# BI rules for the Fabric-X token v2 gateways fxa-gw-<N> (Lensa model fabricx-adapter). Envoy asks OPA for every request; the static
# policy fxa.authz (deploy/k8s/fxa-gw/policy.rego) checks the route allowlist and, for a write, needs BOTH this package's `allow` and
# bank.fxa's. The node comes from Envoy's context_extensions {node: "node<N>"}. BI's document is data.bi.config.policy["fabricx-adapter"]
# (max_per_tx, max_mint_per_tx, hours, holidays, frozen: the same schema as the other platforms). No document = every write denied.
# Token v2 bodies (apps/token/overlay/common/regulated): issue {Asset, Units, Recipient}, transfer {Asset, Units, Sender, Recipient},
# dvp-offer {Buyer, SecurityUnits, MoneyUnits}, dvp-accept {OfferID, TermsHash} (terms fixed by the ledger: 1 SBN for 1.000.000.000 RD),
# dvp-settle {OfferID}. Asset RupiahDigital is RD, SBN is DFABI. Units are decimal strings without leading zeros.
package bi.fxa

import data.bi.clock
import data.bi.ident

req := input.attributes.request.http

own := input.attributes.contextExtensions.node

# json.is_valid first: an unmarshal error inside `not` is not "undefined", it silently drops the rule that should deny
body := json.unmarshal(req.body) if {
	req.method == "POST"
	json.is_valid(req.body)
}

policy := data.bi.config.policy["fabricx-adapter"]

node_of_org := {"bi": "node1", "bank-a": "node2", "bank-b": "node3", "bank-c": "node4"}

token_of := {"RupiahDigital": "RD", "SBN": "DFABI"}

# The award's money leg, fixed by the ledger (policy.go ValidateDvP); dvp-accept carries no amounts.
award_price := "1000000000"

writes := {"/test/issue", "/test/transfer", "/test/dvp-offer", "/test/dvp-accept", "/test/dvp-settle"}

write if {
	req.method == "POST"
	req.path in writes
}

default allow := false

allow if not write

allow if {
	write
	count(reasons) == 0
}

reasons contains "Kebijakan BI untuk Fabric-X (token v2) belum diterbitkan" if {
	write
	not policy
}

# fail closed: a write whose body or asset these rules cannot read is refused here, not passed on unchecked
# `not f(x)` with x undefined does not fire (OPA evaluates x outside the negation), so every negated check below takes defined values only:
# body_ok for the body, field() for its members (null when absent), cap() for limits (0 when absent: nothing passes).
body_ok if is_object(body)

field(k) := object.get(body, k, null)

cap(key, t) := object.get(policy, [key, t], 0)

reasons contains "Permintaan tidak dapat dibaca kebijakan" if {
	write
	not body_ok
}

reasons contains "Aset tidak dikenal kebijakan" if {
	req.path in {"/test/issue", "/test/transfer"}
	not token_of[field("Asset")]
}

amount_ok(amount, cap) if {
	is_string(amount)
	regex.match(`^[1-9][0-9]{0,15}$`, amount)
	to_number(amount) <= cap
}

frozen_nodes := {ident.node_of(f) | some f in policy.frozen}

closed(token) if not clock.token_open("fabricx-adapter", token)

# --- issue (BI's gateway): RD to a bank, SBN to BI itself (the only issues token v2 takes)
reasons contains $"Di luar jam operasional {t}" if {
	req.path == "/test/issue"
	t := token_of[body.Asset]
	closed(t)
}

reasons contains $"Melebihi batas penerbitan {t}" if {
	req.path == "/test/issue"
	policy
	t := token_of[body.Asset]
	not amount_ok(field("Units"), cap("max_mint_per_tx", t))
}

reasons contains "Penerima dibekukan" if {
	req.path == "/test/issue"
	node_of_org[body.Recipient] in frozen_nodes
}

# --- transfer (a bank's gateway)
reasons contains $"Di luar jam operasional {t}" if {
	req.path == "/test/transfer"
	t := token_of[body.Asset]
	closed(t)
}

reasons contains $"Melebihi batas per transaksi {t}" if {
	req.path == "/test/transfer"
	policy
	t := token_of[body.Asset]
	not amount_ok(field("Units"), cap("max_per_tx", t))
}

reasons contains "Pengirim atau penerima dibekukan" if {
	req.path == "/test/transfer"
	some n in {own, node_of_org[body.Recipient]}
	n in frozen_nodes
}

# --- award: BI offers (an SBN issue to the buyer), the buyer accepts (pays the fixed price), BI settles
reasons contains "Di luar jam operasional DFABI atau RD" if {
	req.path in {"/test/dvp-offer", "/test/dvp-accept", "/test/dvp-settle"}
	some t in {"RD", "DFABI"}
	closed(t)
}

reasons contains "Melebihi batas penerbitan DFABI" if {
	req.path == "/test/dvp-offer"
	policy
	not amount_ok(field("SecurityUnits"), cap("max_mint_per_tx", "DFABI"))
}

reasons contains "Melebihi batas per transaksi RD" if {
	req.path == "/test/dvp-offer"
	policy
	not amount_ok(field("MoneyUnits"), cap("max_per_tx", "RD"))
}

reasons contains "Pembeli dibekukan" if {
	req.path == "/test/dvp-offer"
	node_of_org[body.Buyer] in frozen_nodes
}

reasons contains "Melebihi batas per transaksi RD" if {
	req.path == "/test/dvp-accept"
	policy
	not amount_ok(award_price, cap("max_per_tx", "RD"))
}

reasons contains "Pembeli dibekukan" if {
	req.path == "/test/dvp-accept"
	own in frozen_nodes
}
