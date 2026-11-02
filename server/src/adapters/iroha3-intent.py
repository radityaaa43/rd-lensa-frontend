# Print DvpIsi::intent_hash for the instruction `iroha -o app settlement dvp ...` wrote to stdin (Iroha 3 @ 071e281e).
# The CLI has no command for it, and Node has no Blake2b-256, so iroha3.ts runs this with the stdlib python3.
#   intent = Blake2b-256(b"iroha:settlement:dvp-intent:v1\0" || DvpIsi.encode()), last bit set
#     (iroha_data_model isi/settlement.rs:603,624-627; iroha_crypto hash.rs:40,128-134,191-194)
#   DvpIsi bytes = Dvp variant field inside the inner `iroha.settlement` Norito frame
#     (header 40 B, payload length u64 LE at 23: norito core.rs:4119-4143; header flags 2 = compact lengths)
#   literal = "hash:<HEX>#<crc16>" (norito literal.rs:5-28)
import base64, hashlib, json, sys

box = base64.b64decode(json.load(sys.stdin)[0])
i = box.index(b"NRT0", 4)
n = int.from_bytes(box[i + 23:i + 31], "little")
payload = box[i + 40:i + 40 + n]
assert len(payload) == n and payload[:4] == b"\0\0\0\0", "not a SettlementInstructionBox::Dvp"
size, shift, k = 0, 0, 4  # LEB128 length prefix of the Dvp field
while True:
    size |= (payload[k] & 0x7F) << shift
    shift += 7
    k += 1
    if payload[k - 1] < 0x80:
        break
body = payload[k:]
assert len(body) == size, "Dvp field length mismatch"
h = bytearray(hashlib.blake2b(b"iroha:settlement:dvp-intent:v1\0" + body, digest_size=32).digest())
h[-1] |= 1
hexs = h.hex().upper()
crc = 0xFFFF
for b in b"hash:" + hexs.encode():
    crc ^= b << 8
    for _ in range(8):
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
print(f"hash:{hexs}#{crc:04X}")
