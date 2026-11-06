# UTV-009 Cloud API — security architecture / NOT DEPLOYED

## Current state

Current Studio is a local operator-controlled service bound to 127.0.0.1. There is **no** publicly exposed Cloud API, bearer authentication, billing, multi-tenant ACL or untrusted-user browser worker. The utility in src/cloud-egress.mjs is only a **DNS and URL preflight**, not an SSRF protection boundary. No release should claim UTV-009 DONE based on this file.

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
