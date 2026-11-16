# A bank's own rules for its Fabric-X token v2 gateway fxa-gw-<N> (Lensa model fabricx-adapter): data.bank.config.policy["fabricx-adapter"]
# = {counterparties, max_per_tx?, daily_limit?, hours?} (an absent token follows BI only). Node 1's bank bundle is BI's seed (bank-bi).
# Every outflow of this party's write is checked: transfer {Asset, Units, Recipient}, issue (BI) {Asset, Units, Recipient},
# dvp-offer (BI) SBN to the buyer, dvp-accept (the buyer) the award's fixed price 1.000.000.000 RD to BI.
# daily_limit needs today's outflow (00:00 WIB): this party's own token history, read by OPA from the node with the gateway's
# operator certificate (env FXA_HISTORY_URL, FXA_TLS_CERT, FXA_TLS_KEY, FXA_TLS_CA set by render.py). A failed read denies the write.
package bank.fxa

import data.bank.ident

req := input.attributes.request.http

own := input.attributes.contextExtensions.node

# json.is_valid first: an unmarshal error inside `not` is not "undefined", it silently drops the rule that should deny
body := json.unmarshal(req.body) if {
	req.method == "POST"
	json.is_valid(req.body)
}

policy := data.bank.config.policy["fabricx-adapter"]

node_of_org := {"bi": "node1", "bank-a": "node2", "bank-b": "node3", "bank-c": "node4"}

token_of := {"RupiahDigital": "RD", "SBN": "DFABI"}

writes := {"/test/issue", "/test/transfer", "/test/dvp-offer", "/test/dvp-accept", "/test/dvp-settle"}

write if {
	req.method == "POST"
	req.path in writes
}

outflows contains {"to": node_of_org[body.Recipient], "token": token_of[body.Asset], "amount": body.Units} if {
	req.path in {"/test/transfer", "/test/issue"}
}

outflows contains {"to": node_of_org[body.Buyer], "token": "DFABI", "amount": body.SecurityUnits} if req.path == "/test/dvp-offer"

outflows contains {"to": "node1", "token": "RD", "amount": "1000000000"} if req.path == "/test/dvp-accept"

counterparty_nodes contains ident.node_of(c) if some c in policy.counterparties

default allow := false

allow if not write

allow if {
	write
	count(reasons) == 0
}

reasons contains "Kebijakan bank untuk Fabric-X (token v2) belum diterbitkan" if {
	write
	not policy
}

reasons contains $"Penerima bukan counterparty yang diizinkan" if {
	some o in outflows
	o.to != own
	not o.to in counterparty_nodes
}

amount_within(amount, cap) if {
	is_string(amount)
	regex.match(`^[1-9][0-9]{0,15}$`, amount)
	to_number(amount) <= cap
}

reasons contains "Jumlah tidak valid" if {
	some o in outflows
	not regex.match(`^[1-9][0-9]{0,15}$`, o.amount)
}

body_ok if is_object(body)

# an outflow with a missing member is never built, so a write that should carry one and has none is refused
reasons contains "Permintaan tidak dapat dibaca kebijakan" if {
	req.path in {"/test/transfer", "/test/issue", "/test/dvp-offer"}
	count(outflows) == 0
}

reasons contains "Permintaan tidak dapat dibaca kebijakan" if {
	write
	not body_ok
}

reasons contains $"Melebihi batas per transaksi bank {o.token}" if {
	some o in outflows
	cap := policy.max_per_tx[o.token]
	not amount_within(o.amount, cap)
}

window_open(h) if {
	data.bi.clock.weekday in h.days
	h.open <= data.bi.clock.hhmm
	data.bi.clock.hhmm < h.close
}

reasons contains $"Di luar jam operasional bank {o.token}" if {
	some o in outflows
	h := policy.hours[o.token]
	not window_open(h)
}

# --- daily_limit: today's outflow (sent rows since 00:00 WIB that were not rejected) plus this request
asset_token := {"RupiahDigital": "RD", "SBN": "DFABI"}

wib_midnight_ns := time.parse_ns("2006-01-02", data.bi.clock.today) - 25200000000000

# a missing env var is "" (the read then fails and the write is denied), never an undefined request
env(k) := object.get(opa.runtime().env, k, "")

history := http.send({
	"method": "GET",
	"url": env("FXA_HISTORY_URL"),
	"tls_client_cert_file": env("FXA_TLS_CERT"),
	"tls_client_key_file": env("FXA_TLS_KEY"),
	"tls_ca_cert_file": env("FXA_TLS_CA"),
	"timeout": "5s",
	"raise_error": false,
	"cache": false,
})

used_today[t] := sum([to_number(r.units) |
	some r in history.body.transactions
	r.direction == "sent"
	r.status != "rejected"
	asset_token[r.asset] == t
	time.parse_rfc3339_ns(r.timestamp) >= wib_midnight_ns
]) if {
	some t, _ in policy.daily_limit
	history.status_code == 200
}

# only the tokens this request moves and the bank limits: a write without such an outflow never reads the history
requested[t] := sum([to_number(o.amount) | some o in outflows; o.token == t]) if {
	some x in outflows
	t := x.token
	policy.daily_limit[t]
}

reasons contains "Pemakaian harian tidak dapat dibaca" if {
	some t, _ in requested
	not used_today[t]
}

reasons contains $"Melebihi limit harian bank {t}" if {
	some t, limit in policy.daily_limit
	used_today[t] + requested[t] > limit
}
