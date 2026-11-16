#!/usr/bin/env bash
# Custody step for the fxa-gw Kebijakan (a person runs it once; it writes Secrets, never prints a key or a token):
#   - one RSA bundle-signing key per party (bi, bank-a, bank-b, bank-c), kept in $FXA_POLICY_DIR (default ~/.fxa-policy, mode 700)
#   - one sink bearer token per party
#   - in each party namespace: fxa-gw-<N>-signing {key.pem}, fxa-gw-<N>-verify {bi.pem, <keyid>.pem}, fxa-gw-<N>-sink-token {token}
#   - in rd-lensa: fxa-sink-tokens {BI, A, B, C} (Lensa's LENSA_FXA_SINK_TOKENS_DIR)
# Existing key/token files are reused, so a rerun re-applies the same Secrets. Kubeconfigs: KUBE_JKT (bi, bank-a, bank-b, rd-lensa), KUBE_SG (bank-c).
set -euo pipefail
umask 077
DIR=${FXA_POLICY_DIR:-$HOME/.fxa-policy}
KUBE_JKT=${KUBE_JKT:-$HOME/.kube/alibaba.yaml}
KUBE_SG=${KUBE_SG:-$HOME/.kube/alibaba-sg.yaml}
mkdir -p "$DIR" && chmod 700 "$DIR"

declare -A N=([bi]=1 [bank-a]=2 [bank-b]=3 [bank-c]=4)
for p in bi bank-a bank-b bank-c; do
  [ -s "$DIR/$p.key" ] || openssl genrsa -out "$DIR/$p.key" 2048 2>/dev/null
  openssl rsa -in "$DIR/$p.key" -pubout -out "$DIR/$p.pem" 2>/dev/null
  [ -s "$DIR/$p.token" ] || openssl rand -hex 32 | tr -d '\n' > "$DIR/$p.token"
done

apply() { kubectl --kubeconfig "$1" apply -f - >/dev/null; }
for p in bi bank-a bank-b bank-c; do
  kc=$KUBE_JKT; [ "$p" = bank-c ] && kc=$KUBE_SG
  ns=fabricx-$p gw=fxa-gw-${N[$p]}
  verify=("--from-file=bi.pem=$DIR/bi.pem"); [ "$p" = bi ] || verify+=("--from-file=$p.pem=$DIR/$p.pem")
  kubectl create secret generic "$gw-signing" -n "$ns" --from-file=key.pem="$DIR/$p.key" --dry-run=client -o yaml | apply "$kc"
  kubectl create secret generic "$gw-verify" -n "$ns" "${verify[@]}" --dry-run=client -o yaml | apply "$kc"
  kubectl create secret generic "$gw-sink-token" -n "$ns" --from-file=token="$DIR/$p.token" --dry-run=client -o yaml | apply "$kc"
  echo "secrets $ns/$gw-{signing,verify,sink-token} applied"
done
kubectl create secret generic fxa-sink-tokens -n rd-lensa \
  --from-file=BI="$DIR/bi.token" --from-file=A="$DIR/bank-a.token" --from-file=B="$DIR/bank-b.token" --from-file=C="$DIR/bank-c.token" \
  --dry-run=client -o yaml | apply "$KUBE_JKT"
echo "secret rd-lensa/fxa-sink-tokens applied (mount it as LENSA_FXA_SINK_TOKENS_DIR)"
