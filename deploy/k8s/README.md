# Lensa in the cluster: manifests (plan S4-S6)

Source of truth: `final-design/lensa/PLAN.md` in platform-exploration. These files render the objects of S4a (`base`), S4b (`volume`) and S6 (`app`) for namespace `rd-lensa` on cluster 1. Nothing here talks to a cluster.

```bash
deploy/k8s/test.sh                        # offline test: bash + python3 + PyYAML
deploy/k8s/render.sh base                 # namespace, default-deny, DNS and gateway egress policies, SAs and Roles (entry A)
deploy/k8s/render.sh volume               # PVC lensa-state 5Gi, StorageClass rd-retain-essd (LENSA_STORAGE_CLASS overrides)
LENSA_IMAGE=ghcr.io/radityaaa43/rd-lensa-frontend@sha256:<digest> LENSA_ENV_FILE=<file> deploy/k8s/render.sh app
```

- Entry A is the default (user answer L1): ClusterIP only; viewers use `kubectl -n rd-lensa port-forward svc/lensa 8790:8790` with a token of SA `lensa-access`. `LENSA_ENTRY=b` renders the CLB ingress policy instead (not planned).
- `gateways.conf` is the egress allow-list. It is empty until each platform's gateway step names its pod label and ports; empty renders a policy with no egress rule (deny). Bank C is one `/32` per public gateway load balancer.
- Secrets are never rendered. Their owners create them, create-only: `ghcr-pull` (a copy of the existing cluster-1 Secret), `lensa-gw-mtls-bi|a|b|c` (keys `ca.crt`, `lensa.crt`, `lensa.key`). The pod mounts them at `/certs/<BI|A|B|C>/` and does not start when one is missing.
- The ConfigMap `lensa-env` takes gateway URLs and Besu doors from `LENSA_ENV_FILE` (allow-listed keys only; a value with `@`, a quote, a backslash or a space is refused: no credentials in URLs).
- `lensa-sink-tokens` (keys `BI`, `A`, `B`, `C`; 64 hex characters, no newline) is the Secret behind `LENSA_SINK_TOKENS_DIR=/sink-tokens`: created by the gateway operators, create-only, never rendered. It is a required volume: create it BEFORE the `app` apply, or the rolled pod stays in ContainerCreating with NO pod serving (the strategy is Recreate: the old pod is stopped first). Check that `lensa-sink-tokens` exists before the apply.
- Apply order of the S5 step (each its own object-level apply, under the lock, after the gateways it points to exist): (1) `allow-from-lensa` in each party namespace (the platform owner's render); (2) `egress-party-gateways` from `render.sh base` (only that object); (3) the Secrets above; (4) `lensa-env` + Deployment from `render.sh app` (one pod roll).
- The image must be a ghcr digest reference of `ghcr.io/radityaaa43/rd-lensa-frontend`; a tag is refused.

Not verified offline [unverified until S4a/S6 run]: that the cluster CNI lets `kubectl port-forward` reach a pod under `default-deny-all` (kubelet-originated traffic is normally exempt); the CoreDNS label `k8s-app=kube-dns`; the pod's real CPU and memory (the numbers in `templates/app.yaml` are starting values).

Cluster 1 today: `rd-retain-essd` does not exist there, so `lensa-state` runs on `alicloud-essd-wffc` (applied with `LENSA_STORAGE_CLASS=alicloud-essd-wffc`). That class deletes the disk with the claim, so after the first bind (the S6 pod) only that PV's `spec.persistentVolumeReclaimPolicy` is patched to `Retain`.

Probes: startup and liveness use `/api/livez`, readiness uses `/api/readyz` (503 until a model loaded, so an unseeded state keeps the pod Running and out of the Service instead of restarting it).
