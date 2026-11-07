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
- No tenant-facing or network token-administration route exists. The provider-neutral cloud bootstrap can call this capability only after an injected MFA-verifying operator authenticator authorizes the reload; the secret-manager adapter itself remains deployment supplied.
- Staged rotation: add the new credential with a new `tokenId` and the same `principalId`; deploy the new secret to clients; verify use of the new credential; then revoke the old `tokenId`. `replace` can also atomically replace the complete in-memory registry, including an empty set for emergency disablement.
- Revocation takes effect for subsequent requests in the current process. It does not cancel requests already authenticated or revoke a token in another process unless that process receives the same secret-manager update. Rehydrate the complete registry from the secret manager at startup and broadcast replacements to every API replica.
- Token expiry, rotation and revocation actions are written to the SQLite audit ledger before the in-memory registry changes. Audit records contain only token IDs, principal IDs, tenant IDs and operator IDs, never credential material.
- The registry itself is in memory only. A vendor secret-manager client, multi-replica distribution/coordinator, break-glass process, provider-side audit and independent operational validation remain deployment requirements.

Trusted host-code usage (not an HTTP endpoint):

```js
const nextCredentials = await secretManager.readCloudCredentials();
studio.tokenAdmin.replace(nextCredentials, { actorId: 'platform-operator' });

// After clients have switched to the replacement credential:
studio.tokenAdmin.revokeToken('service-a-previous', { actorId: 'platform-operator' });
```

Each credential entry contains `tokenId`, `principalId`, `token`, `tenantId`, `projectIds`, and optional `expiresAt`. Multiple token IDs may share one principal ID only when their tenant and project ACLs are identical. The caller is responsible for authenticating the operator and distributing the new secret to all API replicas.


## Secret-manager bootstrap and operator token reload

- `src/cloud-bootstrap.mjs` exposes `createCloudStudioFromSecretManager({ secretManager, operatorAuthenticator, serverOptions })`. The deployment injects a `secretManager.readCloudSecrets()` adapter that returns `{ version, tokens, auditKeyRing }`; `version` is a monotonically increasing decimal revision string (the provider adapter maps its native version to this revision).
- The bootstrap forces `cloudMode: true` and passes the versioned credentials/key ring to `createStudioServer`; callers cannot override these secret fields through `serverOptions`. Token and key material are never written to environment variables, SQLite or a tenant HTTP response.
- Startup fails closed if the provider is missing, the snapshot/version is invalid, tokens are empty, or the key ring/fingerprints do not validate. The local default CLI is unchanged and remains loopback-only.
- The trusted returned `reloadTokens(context)` operation requires an injected `operatorAuthenticator.authorize(context, { action })` adapter to return an MFA-verified `actorId`. It fetches the latest snapshot and calls the existing audited `tokenAdmin.replace`; if the audit append fails, the active token registry is not changed.
- The provider must advance the decimal `version` whenever token material changes. A changed token set with an unchanged version and rollback to an older revision during the lifetime of a process are rejected. The provider adapter must also guarantee immutable, monotonic revisions across restarts; this bootstrap does not yet provide a cross-replica version coordinator. Concurrent reloads are serialized. Reload refuses audit-key-ring changes; key rotation follows the separate staged workflow above.
- The bootstrap returns only `server`, `status()` and MFA-gated `reloadTokens(context)`. It deliberately does not expose the raw Studio object, `tokenAdmin`, `auditAdmin` or SQLite store, which would bypass the operator gate and expose in-memory signing keys.
- `status()` returns only secret version, token IDs/count and audit key IDs. No HTTP administration endpoint is added.
- This is a provider-neutral adapter contract, not a vendor SDK integration: no AWS Secrets Manager, Azure Key Vault, GCP Secret Manager or Vault client is bundled. The deployment must implement and test the provider adapter and MFA-backed operator authenticator.
- `src/cloud-rollout.mjs` adds a host-side multi-replica rollout coordinator. It reads one immutable secret revision, computes a secret-free SHA-256 snapshot digest, fixes the replica inventory for that rollout, and asks each replica to reload that exact revision through its own secret-manager adapter. The coordinator never sends raw tokens or signing keys to replica RPC clients.
- The operator authenticator must implement `createReplicaAssertion(identity, claims)` and return a short-lived signed assertion scoped to `action`, `rolloutId`, `targetVersion`, `replicaId` and `expiresAt`. Each replica must independently validate that assertion, require its own configured replica ID to equal the assertion audience, and match the `rolloutId` and `expectedVersion` request constraints before applying a reload. The internal replica transport must use mutually authenticated TLS; do not expose this RPC to tenants or the public internet.
- A replica's `reloadTokens(assertion, { expectedVersion, rolloutId })` passes the pinned version to `secretManager.readCloudSecrets({ version })`. The provider must fetch that exact immutable revision and return the same decimal `version`; a provider that silently returns its current/latest value is rejected. The initial coordinator read uses `readCloudSecrets()` to select the target revision.
- The injected durable `rolloutStore` must implement `beginRollout`, `getRollout`, `resumeRollout`, `recordReplicaAck`, `recordReplicaFailure`, `markPartialRollout` and `completeRollout`. Its begin operation must atomically acquire a single active rollout lease, reject a revision older than the last completed revision (and reject a same-version/different-digest snapshot), and bind the immutable replica ID set plus snapshot digest. Both `beginRollout` and `resumeRollout` must return a fresh opaque fencing token. Every acknowledgement, failure, partial and completion write must present that token; a stale coordinator's token must be rejected after a lease is reclaimed. Resume must atomically reacquire the lease for the same partial rollout; only one coordinator may resume it at a time. The store may reclaim an `in_progress` lease only after its configured expiry and must issue a new fencing token. Partial and completed transitions release the lease. Completion must compare-and-set the same rollout/version and require an acknowledgement from every registered replica. Failed replicas must have any stale acknowledgement removed.
- Persist only rollout IDs, decimal secret versions, SHA-256 snapshot digests, replica IDs, token IDs, audit key IDs, actor IDs, timestamps and sanitized error codes. Never persist credential material, MFA sessions, replica assertions or provider error text. The store must be independently durable/shared by all coordinator instances; an in-memory or per-process SQLite implementation is not sufficient for multi-host production.
- Partial rollouts do not automatically roll back replicas that already applied the new version. The result remains `partial`; resume using the same `rolloutId`, the same immutable provider revision and exactly the same replica inventory. A replica already acknowledged is rechecked and skipped only if its live status still matches. Do not revoke the previous credential until every replica acknowledges the replacement and client cutover is confirmed.
- The coordinator is an orchestration engine plus adapter contracts, not a deployed distributed service: no vendor secret-manager client, mTLS replica RPC adapter, durable distributed rollout store or break-glass implementation is bundled. Provider-side audit and independent operational validation remain release gates.

Trusted host bootstrap (illustrative):

```js
import { createCloudStudioFromSecretManager } from './src/cloud-bootstrap.mjs';

const cloud = await createCloudStudioFromSecretManager({
  secretManager, // readCloudSecrets() -> { version, tokens, auditKeyRing }
  operatorAuthenticator, // authorize(context, { action }) -> { actorId, mfaVerified: true }
  serverOptions: {
    outputRoot,
    cloudAllowedHosts: ['api.example.test'],
    cloudTrustedProxy: true,
    cloudWorker, // disposable isolated-worker adapter
  },
});

// Host-only, MFA-protected token refresh; never expose this method as an HTTP route.
await cloud.reloadTokens(operatorSession);
```

## Audit integrity key and verification

Trusted host-code setup:

```js
const cloudAuditKey = await secretManager.read('tutorial/cloud-audit-key');
const studio = createStudioServer({
  outputRoot,
  cloudMode: true,
  cloudAuditKey,
  // Supply the required tokens, Host allowlist, trusted proxy and worker adapter.
});
```

- Pass `cloudAuditKey` to `createStudioServer` only from a trusted secret manager. Cloud mode refuses to start if it is missing or shorter than 32 bytes.
- The versioned key ring is supplied as `cloudAuditKeyRing: { activeKeyId, keys }`; each key ID is the first 16 hex characters of that key's SHA-256 fingerprint. Every event stores its key ID, and verification resolves the matching historical key.
- Rotation is available only through trusted host code via `studio.auditAdmin.rotateSigningKey({ keyId, key, actorId })`. It verifies the existing chain first, adds a new key without removing historical keys, switches the active signer, and records `audit.signing_key_rotated` under the new key. Old keys must remain available for verification.
- Before rotating, add the new key to the secret manager and distribute a key ring containing both old and new keys to every replica. Rotate each replica, verify its chain, then update the secret manager's active key ID. Do not remove an old key until an approved archive/retention policy proves no retained local event needs it.
- Pre-key-ID signed rows are migrated only after verifying the legacy HMAC chain with the prior single key. When using a key ring for this one-time migration, set `activeKeyId` to the legacy key's fingerprint; after migration and verification, rotate to the new key. Migration refuses to rewrite a prefix already acknowledged by the external archive. If legacy verification fails or the old key is unavailable, cloud startup fails closed.
- A rotation is not a substitute for secret-manager integration or multi-replica orchestration. The caller must authenticate the operator, update the secret manager and coordinate all replicas.
- HMAC signing and checkpoint updates occur in the same `BEGIN IMMEDIATE` transaction as each audit append. Startup verifies every sequence and signature before accepting cloud traffic.
- The signing key is not a database field, environment dump, audit detail or HTTP response. Do not log it or expose it to workers/tenants.
- This is tamper evidence, not immutable storage: a privileged attacker with database write access can roll back the database to an older valid snapshot. External append-only archival and independently stored checkpoints remain release gates.

## Durable rate limiting and audit trail

- Authenticated API requests consume a tenant-scoped sliding-window event in SQLite under `BEGIN IMMEDIATE`; concurrent API processes cannot independently admit requests beyond the configured tenant limit.
- Request events older than the one-minute window are pruned during admission. The counter survives process restarts and is independent per tenant.
- Cloud job admission writes the job row, daily submission quota event and `job.submitted` / `job.retry_submitted` audit event in one SQLite transaction.
- The audit table records tenant, project, configured principal ID, action, resource/job ID, outcome, timestamp and bounded non-secret details. It records job submission, completion, failure, cancellation, quota denials and project ACL denials.
- Bearer tokens, authorization headers, request bodies and form values are never written to audit details. Audit rows are not exposed through tenant-facing API routes.
- Cloud mode requires a stable audit-signing secret of at least 32 bytes, supplied by trusted host code from a secret manager. It is never stored in SQLite; the same key must be supplied after every restart.
- Each audit row receives a monotonic sequence, previous-event hash and HMAC-SHA256 signature. The checkpoint is committed in the same SQLite transaction as the event. Existing unsigned rows from the prior schema are backfilled once on first startup with the signing key.
- Cloud startup verifies the complete chain and checkpoint; a missing/wrong key, modified event, missing sequence or broken link prevents cloud mode from starting. `store.verifyCloudAuditChain()` provides an operator-side verification result.
- The HMAC chain detects event modification, insertion and reordering while the signing key remains secret. A database rollback to an older internally consistent snapshot is not detectable without an external checkpoint or append-only archive.
- Versioned signing-key rotation is supported through a trusted in-process capability, with old keys retained for verification. Pre-key-ID signed rows must be migrated while the legacy signer is the active key in the supplied key ring; migration is refused after an external archive checkpoint has advanced. No retention/deletion scheduler, vendor-specific archive sink, independent checkpoint service or operator audit UI is deployed. Disk/database failure can prevent audit writes; production readiness requires monitored storage and explicit retention/export controls.

## Tenant usage metering and budgets

- Cloud API exposes `GET /api/usage` only after bearer authentication and project ACL validation. The response is scoped to the authenticated tenant and the current UTC calendar month; it never includes another tenant's usage.
- Monthly job admission is transactionally counted against both finalized usage rows and active admission reservations. Concurrent requests cannot race past `maxJobsPerMonth`.
- Each job reserves `maxOutputBytesPerJob` against `maxStorageBytesPerTenant` in the same SQLite transaction as job admission and the signed audit event. Admission fails with HTTP 429 when used plus reserved storage would exceed the tenant budget.
- The isolated worker receives the per-job byte ceiling. The Docker adapter checks output size periodically and terminates the worker when the limit is crossed; the API independently measures the completed output and removes output that exceeded the reservation.
- On completion, failure, cancellation or startup recovery, the API records worker wall time, artifact bytes, job type, outcome and an estimated cost in SQLite. Storage usage is held per retained job and released when that job's artifacts are deleted by retention.
- Monthly usage events outlive artifact retention so monthly job/worker/cost totals remain available after videos and reports are pruned. The API response labels the cost as `estimateOnly`; configured rates are operator estimates, not invoices, tax calculations, payment collection or a billing ledger.
- Defaults: 1,000 jobs per tenant/month, 5 GiB retained storage per tenant and 1 GiB maximum output per job. These are conservative software defaults, not a production capacity guarantee. Configure lower/higher values only after host disk quotas, backup and retention behavior are independently reviewed.
- Default illustrative rates are 20 micro-USD per worker second and 10 micro-USD per MiB of output. Operators must configure rates from measured infrastructure costs before using the estimate for customer communication.
- Storage reservations protect concurrent admission, but the Docker output monitor is periodic rather than a kernel filesystem quota. A fast writer may temporarily exceed its ceiling between scans; use a dedicated filesystem/project quota or container storage limit before production.

Example configuration:

```js
createStudioServer({
  cloudMode: true,
  cloudLimits: {
    maxJobsPerMonth: 1000,
    maxStorageBytesPerTenant: 5 * 1024 * 1024 * 1024,
    maxOutputBytesPerJob: 1024 * 1024 * 1024,
  },
  cloudPricing: {
    workerCostPerSecondMicros: 20,
    artifactCostPerMiBMicros: 10,
  },
  // tokens, audit key, trusted proxy and isolated worker are also required
});
```

Trusted rotation example:

```js
const ring = await secretManager.readCloudAuditKeyRing();
// The secret manager already contains both the active and next key.
const studio = createStudioServer({ cloudMode: true, cloudAuditKeyRing: ring, /* other settings */ });
const nextKey = await secretManager.readCloudAuditKey('audit-key-next');
const nextKeyId = createHash('sha256').update(nextKey).digest('hex').slice(0, 16);
// Repeat this trusted rotation on every replica, then verify each chain.
studio.auditAdmin.rotateSigningKey({
  keyId: nextKeyId, key: nextKey, actorId: 'platform-operator',
});
await secretManager.setActiveCloudAuditKeyId(nextKeyId);
```

The sequence above is illustrative: a production operator workflow must coordinate secret-manager state and every API replica. Do not switch the secret manager's active key or remove historical keys until all replicas confirm the new key ring and the audit chain verifies.

## External audit archive contract

- A trusted host process may inject `cloudAuditArchive(batch)` into `createStudioServer`. This callback is not exposed through an HTTP route and must authenticate to an external append-only archive using host-managed credentials.
- The trusted `auditAdmin.archiveBatch({ limit })` capability reads a batch after the durable local archive checkpoint. It verifies the full local HMAC chain before export and includes the previous sequence/hash plus each signed event.
- The archive sink must append idempotently by global event sequence and return the exact final `throughSequence` and `throughHash` it has durably committed. The API refuses a missing, partial or mismatched acknowledgement.
- Only after the exact acknowledgement does SQLite advance its archive checkpoint, using a transaction and compare-and-set against the previous sequence. Concurrent archive attempts cannot move the checkpoint backwards or skip a sequence.
- If the external append succeeds but the local checkpoint write fails, the same batch will be retried. The external sink therefore MUST deduplicate by sequence and reject conflicting payloads for an already stored sequence.
- The archive checkpoint is local operational state. It does not itself prove the external copy is immutable or independently administered. Store the external checkpoint separately from the API host and verify it during disaster recovery.
- The repository exposes the trusted archive callback and checkpoint protocol, but does not ship a vendor-specific sink, retention deletion or archival scheduler. Versioned key rotation is available through `auditAdmin.rotateSigningKey`; every replica must retain historical verification keys and complete rotation before the secret manager's active key changes. Do not delete local audit rows until an independently operated sink, external checkpoint, restore test and retention policy have been deployed and verified.

Trusted host-code shape:

```js
const studio = createStudioServer({
  cloudMode: true,
  cloudAuditArchive: async batch => {
    // Append each event idempotently by sequence to an independently
    // administered append-only store, then return its durable last sequence/hash.
    return externalArchive.appendBatch(batch);
  },
  // other required cloud settings...
});

await studio.auditAdmin.archiveBatch({ limit: 500 });
```

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
- Deploy the external append-only audit sink and independently stored checkpoints; add a scheduler and retention/deletion only after verified archival. Add secret-manager integration, authenticated multi-replica rotation workflow and operational monitoring for SQLite disk/database failures.
- Add real billing/payment integration only if commercial charging is required; replace estimate-only rates with measured infrastructure costs and finance-reviewed pricing. Add artifact encryption and a tested retention/deletion process.
- Add an OS-level host firewall policy for the proxy, independent review of Docker bridge rules, and red-team tests for DNS rebinding, redirects, nested subresources, metadata endpoints, tenant enumeration, parallel abuse and cancellation races.
- Add a cleanup/reconciliation service for orphaned per-job networks after a hard API-host or Docker-daemon failure. Worker process timeout bounds execution, but does not itself remove a network left behind by a host crash.
- Validate the complete deployment on the intended host, including Docker daemon access controls, disk pressure, proxy health, restart recovery and independent security acceptance.

**Do not enable or advertise a public Cloud API yet.** The code now provides a concrete disposable-worker and egress-proxy implementation, but it is not a substitute for deployment hardening, operations, billing, auditability or independent security review.
