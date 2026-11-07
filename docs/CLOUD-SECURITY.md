# UTV-009 Cloud API — security architecture / NOT DEPLOYED

## Current state

Current Studio is a local operator-controlled service bound to 127.0.0.1. An opt-in, testable tenant-auth control-plane mode now exists in the server factory, but there is **no publicly exposed or CLI-enabled Cloud API**, no production token lifecycle, billing/audit ledger, deployed multi-tenant worker, or network isolation. The utility in src/cloud-egress.mjs is only a **DNS and URL preflight**, not an SSRF protection boundary. No release should claim UTV-009 DONE based on this code.

## Local egress-proxy integration hook

`src/browser.mjs` now honors `TUTORIAL_EGRESS_PROXY` when launching Chromium, using Playwright's browser proxy option. This is a connection point for a future worker deployment, **not an enforced network boundary by itself**. If the container has an unrestricted network route, a target page may still attempt non-browser or non-proxy egress.

A deployment must attach the worker only to a private/internal network and give it a route to the internet solely through a separately managed egress proxy/firewall. The proxy must resolve and enforce destination IP policy at connection time, deny loopback/private/link-local/multicast/metadata destinations and unsafe ports, and be tested against redirect chains, DNS rebinding and iframe/subresource requests. No Cloud API is currently exposed and this hook is not production-ready.

## Implemented control-plane slice (not deployment-ready)

The local Studio factory now has an opt-in `cloudMode` for exercising the authenticated control-plane contract. It is not enabled by the CLI and does not change the default loopback-only Studio.

- Requires an explicit allowlist of hostnames, a trusted TLS-terminating reverse proxy that strips/replaces `X-Forwarded-Proto`, and an injected isolated-worker adapter. Every request must carry `X-Forwarded-Proto: https`. The factory refuses cloud mode if the trusted-proxy or worker adapter is absent; local browser execution is not used by cloud-mode jobs.
- Requires configured bearer tokens. Each token must contain at least 32 characters and maps to a server-defined tenant plus an explicit list of project IDs.
- Token digests (SHA-256) are held in memory; request tokens are compared in constant time. Raw bearer tokens are not returned by any API.
- Every non-health API request requires `Authorization: Bearer …` and `X-Project-ID`. Tenant identity is derived only from the verified token; body-supplied tenant/project IDs are ignored.
- Jobs persist their tenant/project scope. History, job details, retry, cancellation, assembly, screenshots, subtitles and video downloads are all scoped to the authenticated project; out-of-scope job IDs return 404.
- Default per-tenant limits: 60 API requests/minute, 2 concurrent queued/running jobs, and 50 job submissions in a rolling 24-hour window. Limits are configurable in the server factory. Daily submission events are recorded transactionally in SQLite and survive Studio restarts; the request-rate window remains in memory. The existing global queue cap and 512 KiB body cap remain in force.
- Hosted AI generation is rejected in cloud mode until billing/cost controls exist. The local Studio UI is not served in cloud mode.
- Regression tests cover missing/invalid credentials, Host/Origin allowlists, project/tenant isolation, spoofed body IDs, tenant-wide concurrency/daily quotas and independent rate limits.

This slice is **control-plane authorization and admission control only**. The worker adapter is an injection point, not an implementation of the isolated worker; tests use a harmless in-process fixture and no production adapter is supplied. Request-rate counters are in memory and reset on restart; rolling daily job submissions are durable in SQLite. It does not provide token rotation/revocation APIs, durable billing/audit ledgers, TLS termination, a public deployment, a worker sandbox, or network egress enforcement. The CLI remains loopback-only. Do not expose or deploy this mode until the trusted proxy is deployed, the worker adapter forwards to a single-use isolated worker whose network namespace is restricted to a verified egress firewall/proxy, and the remaining release gates below are met.

## Target architecture

Browser-facing API (authenticated tenant/project) → throttled job queue → single-use browser worker in isolated container/microVM → restricted outbound egress proxy → artifact store with tenant ACL and time-limited signed URLs → cleanup worker.

Security baseline before any public launch:

- Authenticate all API calls with a rotating token; support tenants with project-level authorization. Never accept tenantId from the browser without verifying the current principal.
- Enforce per-tenant quota, concurrent job limit, runtime ceiling, max bytes and cost safeguards before queue admission.
- Browser worker must have a non-root identity, no host mounts, no Docker socket, ephemeral home, no credential share, no privileged syscalls and a kill-switch.
- Block RFC1918, loopback, link-local, multicast, metadata services, internal DNS and non-HTTPS in the **actual network namespace**. DNS and proxy resolution must both be constrained at connection time. Reject redirect chains and subrequests that reach private networks. Node-side DNS preflight is not sufficient against DNS rebinding.
- Use per-job credentials injected from a scoped secret store. Never include API keys, cookies, session identifiers or payment fields in artifacts or logs.
- Require explicit opt-in for authenticated sessions; stop at CAPTCHA/MFA without bypassing controls.
- Store private artifacts encrypted and tenant-scoped, with absolute retention and deletion procedures.
- Implement CSRF protections for cookie auth, Origin/Host validation, rate limits, idempotency keys for submitted jobs and audit logs for every state change.
- Red-team SSRF, redirect rebinding, tenant enumeration, leaked screenshot, parallel tasks, size bombs and cancellation/replay edge cases before promotion to production.

## Evidence and acceptance

The local helper rejects common reserved addresses, metadata IPv4, loopback IPv6, unsafe schemes and password-embedded URLs in unit tests. This is not a browser-network sandbox.

Release gate remains OPEN until production egress can be demonstrated at the OS/network layer, auth/ACL and quotas are implemented, and independent security tests pass.
