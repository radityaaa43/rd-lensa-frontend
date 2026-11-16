package fxa_test

import rego.v1

bi_doc := {
	"max_per_tx": {"RD": 1000000000, "DFABI": 1000},
	"max_mint_per_tx": {"RD": 1000000000000000, "DFABI": 1000},
	"hours": {
		"RD": {"days": [1, 2, 3, 4, 5, 6, 7], "open": "00:00", "close": "24:00"},
		"DFABI": {"days": [1, 2, 3, 4, 5, 6, 7], "open": "00:00", "close": "24:00"},
	},
	"holidays": [], "frozen": [],
}

bank_a := {"counterparties": ["bi@node1", "bankB@node3"], "max_per_tx": {"RD": 500}, "daily_limit": {"RD": 1000}}

req(node, method, path, body) := {"attributes": {
	"contextExtensions": {"node": node},
	"request": {"http": {"method": method, "path": path, "body": json.marshal(body)}},
}}

xfer(node, units, to) := req(node, "POST", "/test/transfer", {"Asset": "RupiahDigital", "Units": units, "Sender": "bank-a", "Recipient": to})

history(rows) := {"status_code": 200, "body": {"transactions": rows}}

today_ts := time.format([time.now_ns(), "UTC", "2006-01-02T15:04:05Z07:00"])

no_history(_) := {"status_code": 200, "body": {"transactions": []}}

used_600(_) := history([{"direction": "sent", "status": "confirmed", "asset": "RupiahDigital", "units": "600", "timestamp": today_ts}])

down(_) := {"status_code": 0}

allowed(i) if {
	data.bi.fxa.allow with input as i with data.bi.config.policy as {"fabricx-adapter": bi_doc}
	data.bank.fxa.allow with input as i with data.bank.config.policy as {"fabricx-adapter": bank_a} with http.send as no_history
}

test_reads_need_no_document if {
	i := req("node2", "GET", "/test/balance", {})
	data.bi.fxa.allow with input as i
	data.bank.fxa.allow with input as i
}

test_write_without_document_is_denied if {
	not data.bi.fxa.allow with input as xfer("node2", "1", "bank-b")
	not data.bank.fxa.allow with input as xfer("node2", "1", "bank-b")
}

test_transfer_within_limits if allowed(xfer("node2", "100", "bank-b"))

test_bank_cap_and_counterparty if {
	r := data.bank.fxa.reasons with input as xfer("node2", "600", "bank-c") with data.bank.config.policy as {"fabricx-adapter": bank_a} with http.send as no_history
	"Melebihi batas per transaksi bank RD" in r
	"Penerima bukan counterparty yang diizinkan" in r
}

test_daily_limit_counts_today if {
	r := data.bank.fxa.reasons with input as xfer("node2", "500", "bank-b") with data.bank.config.policy as {"fabricx-adapter": bank_a} with http.send as used_600
	r == {"Melebihi limit harian bank RD"}
	ok := data.bank.fxa.reasons with input as xfer("node2", "300", "bank-b") with data.bank.config.policy as {"fabricx-adapter": bank_a} with http.send as used_600
	count(ok) == 0
}

test_daily_limit_fails_closed if {
	r := data.bank.fxa.reasons with input as xfer("node2", "1", "bank-b") with data.bank.config.policy as {"fabricx-adapter": bank_a} with http.send as down
	"Pemakaian harian tidak dapat dibaca" in r
}

test_bi_caps_and_frozen if {
	frozen := object.union(bi_doc, {"frozen": ["bankB@node3"]})
	r := data.bi.fxa.reasons with input as xfer("node2", "2000000000", "bank-b") with data.bi.config.policy as {"fabricx-adapter": frozen}
	"Melebihi batas per transaksi RD" in r
	"Pengirim atau penerima dibekukan" in r
}

test_bi_issue_mint_cap if {
	i := req("node1", "POST", "/test/issue", {"Asset": "SBN", "Units": "1001", "Recipient": "bi"})
	r := data.bi.fxa.reasons with input as i with data.bi.config.policy as {"fabricx-adapter": bi_doc}
	r == {"Melebihi batas penerbitan DFABI"}
}

test_award_accept_checks_the_fixed_price if {
	i := req("node2", "POST", "/test/dvp-accept", {"OfferID": "o1", "TermsHash": "h"})
	low := object.union(bi_doc, {"max_per_tx": {"RD": 999999999, "DFABI": 1000}})
	"Melebihi batas per transaksi RD" in data.bi.fxa.reasons with input as i with data.bi.config.policy as {"fabricx-adapter": low}
	r := data.bank.fxa.reasons with input as i with data.bank.config.policy as {"fabricx-adapter": bank_a} with http.send as no_history
	"Melebihi limit harian bank RD" in r
}

test_unreadable_body_or_asset_is_denied if {
	bad := {"attributes": {"contextExtensions": {"node": "node2"}, "request": {"http": {"method": "POST", "path": "/test/transfer", "body": "not json"}}}}
	not data.bi.fxa.allow with input as bad with data.bi.config.policy as {"fabricx-adapter": bi_doc}
	odd := req("node2", "POST", "/test/transfer", {"Asset": "Gold", "Units": "1", "Sender": "bank-a", "Recipient": "bank-b"})
	"Aset tidak dikenal kebijakan" in data.bi.fxa.reasons with input as odd with data.bi.config.policy as {"fabricx-adapter": bi_doc}
}

test_closed_hours if {
	shut := object.union(bi_doc, {"hours": {"RD": {"days": [], "open": "00:00", "close": "24:00"}, "DFABI": bi_doc.hours.DFABI}})
	"Di luar jam operasional RD" in data.bi.fxa.reasons with input as xfer("node2", "1", "bank-b") with data.bi.config.policy as {"fabricx-adapter": shut}
}

test_seeds_pass_the_validators if {
	count(data.bi.check.errors) == 0 with data.bi.config.policy as {"fabricx-adapter": bi_doc} with data.bi.config.platforms as ["fabricx-adapter"]
	count(data.bank.check.errors) == 0 with data.bank.config.policy as {"fabricx-adapter": bank_a} with data.bi.config.policy as {"fabricx-adapter": bi_doc} with data.bi.config.platforms as ["fabricx-adapter"]
}

test_missing_units_is_denied_by_both if {
	i := req("node2", "POST", "/test/transfer", {"Asset": "RupiahDigital", "Sender": "bank-a", "Recipient": "bank-b"})
	not data.bi.fxa.allow with input as i with data.bi.config.policy as {"fabricx-adapter": bi_doc}
	not data.bank.fxa.allow with input as i with data.bank.config.policy as {"fabricx-adapter": bank_a} with http.send as no_history
}
