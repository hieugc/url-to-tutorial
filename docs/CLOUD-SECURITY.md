# UTV-009 Cloud API — security architecture / NOT DEPLOYED

## Current release state

The default Studio remains local-only and the CLI binds to `127.0.0.1`. The opt-in cloud server factory now has tenant/project authentication, quotas, a disposable Docker worker adapter and a DNS-pinned HTTPS egress proxy. These are implemented components, **not a deployed public Cloud API**. Do not expose the service until the remaining release gates below are completed and independently reviewed.

## Implemented control-plane protections

- Bearer tokens are configured server-side, must be at least 32 characters, and are stored in memory only as SHA-256 digests. Authentication uses constant-time digest comparison.
- Each token maps to a server-defined tenant and explicit project allowlist. Tenant identity never comes from request JSON; every non-health API call requires `X-Project-ID`.
- Job history, details, retry, cancel, assembly and artifact routes are scoped to the authenticated tenant + project. Out-of-scope IDs return 404.
- Default quotas: 60 requests/minute, 2 concurrent jobs and 50 job submissions per rolling 24 hours per tenant. Daily submission events and sliding-window request events are transactionally stored in SQLite; request limits survive API restarts and are isolated by tenant. SQLite serializes concurrent admission transactions.
- The cloud API factory requires an explicit Host allowlist, a trusted TLS-terminating proxy assertion and an isolated-worker adapter. It rejects non-HTTPS/private/reserved targets using DNS preflight before queue admission.
- Cloud mode rejects hosted AI, interactive preview and render plans containing `click`, `fill` or `navigate`. Only read-only `highlight`, `branch` and `stop` plans are accepted.
- The local Studio UI is not served in cloud mode. The existing global queue cap and 512 KiB request-body limit remain active.

## Bearer-token rotation, expiry and revocation

- Credentials have a stable `tokenId` (credential identity) and `principalId` (logical service identity). Multiple credentials may overlap for one principal during a planned rotation, but all credentials for that principal must retain the same tenant and project ACL.
- Optional `expiresAt` is an ISO timestamp. Expired credentials fail authentication immediately; expiry is checked for every authenticated request.
- The trusted embedding process receives a non-HTTP `tokenAdmin` capability from `createStudioServer`. It provides `list()`, `replace(nextTokens, { actorId })`, `revokeToken(tokenId, { actorId })` and `revokePrincipal(principalId, { actorId })`. It never returns raw tokens or token digests.
- No tenant-facing or network token-administration route exists. Only trusted host code should call this capability after authenticating an operator and retrieving the replacement credential set from a secret manager.
- Staged rotation: add the new credential with a new `tokenId` and the same `principalId`; deploy the new secret to clients; verify use of the new credential; then revoke the old `tokenId`. `replace` can also atomically replace the complete in-memory registry, including an empty set for emergency disablement.
- Revocation takes effect for subsequent requests in the current process. It does not cancel requests already authenticated or revoke a token in another process unless that process receives the same secret-manager update. Rehydrate the complete registry from the secret manager at startup and broadcast replacements to every API replica.
- Token expiry, rotation and revocation actions are written to the SQLite audit ledger before the in-memory registry changes. Audit records contain only token IDs, principal IDs, tenant IDs and operator IDs, never credential material.
- The registry itself is in memory only. A secret manager, operator authentication/workflow, multi-replica distribution, break-glass process and independent operational validation remain deployment requirements.

## Durable rate limiting and audit trail

- Authenticated API requests consume a tenant-scoped sliding-window event in SQLite under `BEGIN IMMEDIATE`; concurrent API processes cannot independently admit requests beyond the configured tenant limit.
- Request events older than the one-minute window are pruned during admission. The counter survives process restarts and is independent per tenant.
- Cloud job admission writes the job row, daily submission quota event and `job.submitted` / `job.retry_submitted` audit event in one SQLite transaction.
- The audit table records tenant, project, configured principal ID, action, resource/job ID, outcome, timestamp and bounded non-secret details. It records job submission, completion, failure, cancellation, quota denials and project ACL denials.
- Bearer tokens, authorization headers, request bodies and form values are never written to audit details. Audit rows are not exposed through tenant-facing API routes.
- Audit events are durable in the local SQLite database, but currently have no retention/archival policy, external append-only sink, tamper-evident hash chain or operator audit UI. Disk/database failure can prevent audit writes; production readiness requires monitored storage and an explicit retention/export policy.

## Disposable worker and outbound egress boundary

### Per-job network topology

`src/cloud-worker-adapter.mjs` launches one Docker container and one Docker network per job:

1. Create a Docker bridge network with `--internal`. It has no direct external route.
2. Attach only the dedicated `url-tutorial-egress-proxy` container to that network, with DNS alias `egress-proxy`.
3. Run a one-shot worker attached only to that per-job network.
4. Stop/remove the worker, disconnect the proxy and remove the per-job network.

Different jobs do not share a worker network. The worker has no published ports, host network, Docker socket, host source mount or credentials from the API process. Its only writable host mount is that job's output directory.

### Egress proxy behavior

`src/egress-proxy.mjs` is a strict HTTP CONNECT proxy:

- Accepts HTTPS CONNECT only, on TCP port 443. Plain HTTP proxy requests, IP-literal destinations, local/reserved suffixes, malformed/duplicate headers and mismatched Host headers are rejected.
- Resolves each requested hostname once, checks every returned A/AAAA address, and rejects the whole answer set if any address is private, reserved, link-local, multicast, metadata or otherwise non-global.
- Connects directly to the exact validated IP from that DNS response; it does not resolve the hostname again. This closes the proxy-side DNS-rebinding gap between validation and TCP connection.
- Chromium uses the proxy, removes its implicit loopback bypass list and disables QUIC. Redirects, frames and subresources therefore need new proxy tunnels; each hostname is revalidated at connection time.
- The proxy image is non-root, read-only, capability-free, resource-limited and is not published to the host. It joins the internet-facing bridge; worker networks are attached dynamically and individually.

The proxy does not decrypt TLS or inspect URL paths. It allows any globally routable hostname on port 443; it is not a domain allowlist, content filter or abuse-prevention system. Its network boundary depends on workers being attached only to Docker `--internal` networks and on the Docker host/daemon being trusted.

### Worker container hardening

`Dockerfile.worker` and the adapter provide:

- Playwright/Chromium, FFmpeg and eSpeak NG in a versioned worker image. The runtime image must be referenced by immutable `@sha256` digest.
- Non-root UID/GID matching the API host process; read-only root filesystem; all Linux capabilities dropped; `no-new-privileges`; default Docker seccomp; no devices or privileged mode.
- CPU, memory, shared-memory, process-count and wall-clock limits; a bounded `/tmp` tmpfs; one per-job output bind mount.
- A 1 GiB default output-directory ceiling, monitored during execution. This is a watchdog, not a filesystem quota; a fast writer can temporarily exceed the threshold between scans.
- API artifact/report reads use `O_NOFOLLOW`, verify regular files and enforce per-artifact size ceilings, preventing a worker-created symlink from making the host API read arbitrary host files.

### Build and run the proxy service

Build and push the egress proxy image from a verified immutable Node base image. Supply the resulting image digest to Compose:

```bash
docker build \
  --build-arg NODE_BASE_IMAGE='node:22-alpine@sha256:<verified-base-digest>' \
  -f Dockerfile.egress-proxy -t registry.example/url-tutorial-egress:release .
docker push registry.example/url-tutorial-egress:release
docker image inspect --format='{{index .RepoDigests 0}}' registry.example/url-tutorial-egress:release

TUTORIAL_EGRESS_PROXY_IMAGE='registry.example/url-tutorial-egress@sha256:<built-image-digest>' \
  docker compose -f compose.cloud-egress.yml up -d
```

Build the worker image using a verified immutable Playwright base image, push it, and configure `TUTORIAL_WORKER_IMAGE` with its final `@sha256` digest. The adapter refuses mutable tags.

```bash
docker build \
  --build-arg PLAYWRIGHT_BASE_IMAGE='mcr.microsoft.com/playwright:v1.64.1-noble@sha256:<verified-base-digest>' \
  -f Dockerfile.worker -t registry.example/url-tutorial-worker:release .
docker push registry.example/url-tutorial-worker:release
docker image inspect --format='{{index .RepoDigests 0}}' registry.example/url-tutorial-worker:release
```

The trusted API process must run as a non-root host user with access to the Docker daemon and must inject `createDockerWorkerAdapter({ image: process.env.TUTORIAL_WORKER_IMAGE, allowedOutputRoot })` into `createStudioServer`. Docker-daemon access is effectively host-root authority: do not expose its socket to the browser, tenant or worker. If the API itself runs in a container, use a separately hardened Docker API socket proxy with only the minimum required operations. The API must sit behind a real TLS-terminating reverse proxy that strips client-supplied forwarding headers and sets `X-Forwarded-Proto: https`; `cloudTrustedProxy: true` is an operator assertion, not automatic proxy verification.

No public cloud startup command or deployment is included in this PR. The default CLI is unchanged and remains loopback-only.

## Regression evidence

- Unit tests cover IPv4/IPv6 special-purpose ranges, malformed CONNECT requests, port/host policy, mixed public/private DNS answers, DNS pinning, tunnel relay, worker envelope validation, read-only action policy, adapter lifecycle, non-root/resource restrictions and symlink-safe artifact access.
- `npm run test:cloud:docker` builds the proxy image and checks on a real Docker bridge that a worker network cannot connect directly to a public IP, can reach public HTTPS through the proxy, and cannot CONNECT to localhost.
- Linux CI runs the Docker network integration test; the regular Linux and macOS suites continue to run the Node/Chromium regression suite.

## Remaining release gates — keep UTV-009 OPEN

- Deploy and independently verify the TLS reverse proxy, Host allowlist and trusted forwarding-header behavior.
- Add a secret-manager integration, authenticated operator workflow, multi-replica credential distribution, tenant/project administration and break-glass procedures.
- Add audit retention/archival, an external append-only sink or tamper-evident integrity protection, and operational monitoring for SQLite disk/database failures.
- Add billing/cost accounting, per-tenant storage budgets, artifact encryption and a tested retention/deletion process.
- Add an OS-level host firewall policy for the proxy, independent review of Docker bridge rules, and red-team tests for DNS rebinding, redirects, nested subresources, metadata endpoints, tenant enumeration, parallel abuse and cancellation races.
- Add a cleanup/reconciliation service for orphaned per-job networks after a hard API-host or Docker-daemon failure. Worker process timeout bounds execution, but does not itself remove a network left behind by a host crash.
- Validate the complete deployment on the intended host, including Docker daemon access controls, disk pressure, proxy health, restart recovery and independent security acceptance.

**Do not enable or advertise a public Cloud API yet.** The code now provides a concrete disposable-worker and egress-proxy implementation, but it is not a substitute for deployment hardening, operations, billing, auditability or independent security review.
