# cloud-replica-mtls.mjs

[Mở module nguồn](../../../src/cloud-replica-mtls.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### requireText

`requireText(value, name)` · [Dòng 11–16](../../../src/cloud-replica-mtls.mjs#L11)

- Lời gọi trong thân hàm: `value.trim`.
- Kết quả: `value`.

### normalizeFingerprint

`normalizeFingerprint(value, name = 'certificate fingerprint')` · [Dòng 18–23](../../../src/cloud-replica-mtls.mjs#L18)

- Lời gọi trong thân hàm: `value.replaceAll`.
- Kết quả: `normalized`.

### safeStatus

`safeStatus(value)` · [Dòng 25–50](../../../src/cloud-replica-mtls.mjs#L25)

- Lời gọi trong thân hàm: `Array.isArray`, `VERSION.test`, `value.tokenIds.some`, `ring.keyIds.some`, `ring.keyIds.includes`, `Object.freeze`.
- Kết quả: `{secretVersion, tokenIds, auditKeyRing}`.
- Lỗi trực tiếp có thông điệp cố định: `Replica status contains invalid or unsafe metadata`, `Replica status contains invalid audit key metadata`.

### sendJson

`sendJson(res, status, value)` · [Dòng 52–61](../../../src/cloud-replica-mtls.mjs#L52)

- Lời gọi trong thân hàm: `JSON.stringify`, `res.writeHead`, `Buffer.byteLength`, `res.end`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### readJson

`readJson(req, maxBytes)` · [Dòng 63–89](../../../src/cloud-replica-mtls.mjs#L63)

- Lời gọi trong thân hàm: `String`, `Object.assign`, `/^\d+$/.test`, `Number`, `chunks.push`, `JSON.parse`, `Buffer.concat`, `Array.isArray`, `Object.getPrototypeOf`.
- Kết quả: `parsed`.

### validateServerBinding

`validateServerBinding(host)` · [Dòng 91–113](../../../src/cloud-replica-mtls.mjs#L91)

- Lời gọi trong thân hàm: `requireText`, `isIP`, `host.split`, `host.toLowerCase`.
- Kết quả: `host`.
- Lỗi trực tiếp có thông điệp cố định: `Replica RPC server must bind to a literal private IP address`, `Replica RPC server must bind to a loopback or RFC1918 private IPv4 address`, `Replica RPC server must bind to loopback or IPv6 unique-local address`.

### peerFingerprint

`peerFingerprint(req)` · [Dòng 115–119](../../../src/cloud-replica-mtls.mjs#L115)

- Lời gọi trong thân hàm: `req.socket.getPeerCertificate`, `normalizeFingerprint`.
- Kết quả: `null`, `normalizeFingerprint(certificate.fingerprint256)`.

### createMtlsReplicaServer

`createMtlsReplicaServer({ key, cert, ca, replicaId, allowedClientFingerprints, reloadTokens, status, host = '127.0.0.1', maxBodyBytes = MAX_BODY_BYTES, } = {})` · [Dòng 126–226](../../../src/cloud-replica-mtls.mjs#L126)

- Lời gọi trong thân hàm: `requireText`, `IDENTIFIER.test`, `Array.isArray`, `allowedClientFingerprints.map`, `validateServerBinding`, `Number.isInteger`, `https.createServer`, `Object.freeze`.
- Kết quả: `{server, listen, close}`.
- Lỗi trực tiếp có thông điệp cố định: `A valid replica ID is required`, `An explicit client certificate fingerprint allowlist is required`, `Replica reloadTokens and status capabilities are required`, `Replica RPC body limit must be between 256 bytes and 16 KiB`.

### createMtlsReplicaServer → listen

`listen(port = 0)` · [Dòng 209–217](../../../src/cloud-replica-mtls.mjs#L209)

- Kết quả: `new Promise((resolve, reject) => { const onError = error => { server.off('listening', onListening); reject(…`.

### createMtlsReplicaServer → onError

`onError(error)` · [Dòng 211–211](../../../src/cloud-replica-mtls.mjs#L211)

- Lời gọi trong thân hàm: `server.off`, `reject`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### createMtlsReplicaServer → onListening

`onListening()` · [Dòng 212–212](../../../src/cloud-replica-mtls.mjs#L212)

- Lời gọi trong thân hàm: `server.off`, `resolve`, `server.address`.
- Kết quả: không có return tường minh; caller quan sát side effect hoặc lỗi.

### createMtlsReplicaServer → close

`close()` · [Dòng 218–224](../../../src/cloud-replica-mtls.mjs#L218)

- Kết quả: `new Promise((resolve, reject) => { if (!server.listening) return resolve(); server.close(error => error ? r…`.

### createMtlsReplicaClient

`createMtlsReplicaClient({ id, url, ca, cert, key, expectedServerFingerprint, timeoutMs = 10_000, } = {})` · [Dòng 233–341](../../../src/cloud-replica-mtls.mjs#L233)

- Lời gọi trong thân hàm: `IDENTIFIER.test`, `requireText`, `Number.isInteger`, `['', '/'].includes`, `isIP`, `normalizeFingerprint`, `Object.freeze`.
- Kết quả: `{id, status, reloadTokens}`.
- Lỗi trực tiếp có thông điệp cố định: `A valid replica ID is required`, `Replica RPC timeout must be between 100 ms and 60 seconds`, `A valid HTTPS replica URL is required`, `Replica RPC URL must be HTTPS without credentials/query; IP endpoints require a certificate pin`.

### createMtlsReplicaClient → request

`request(method, route, payload)` · [Dòng 259–315](../../../src/cloud-replica-mtls.mjs#L259)

- Kết quả: `new Promise((resolve, reject) => { const body = payload === undefined ? null : Buffer.from(JSON.stringify(p…`.

### createMtlsReplicaClient → request → checkServerIdentity

`checkServerIdentity(hostname, certificate)` · [Dòng 272–279](../../../src/cloud-replica-mtls.mjs#L272)

- Lời gọi trong thân hàm: `tls.checkServerIdentity`, `normalizeFingerprint`.
- Kết quả: `error`, `new Error('Replica server certificate fingerprint mismatch')`, `undefined`.

### createMtlsReplicaClient → status

`status()` · [Dòng 319–321](../../../src/cloud-replica-mtls.mjs#L319)

- Lời gọi trong thân hàm: `request`, `encodeURIComponent`.
- Kết quả: `request('GET', '/internal/replicas/' + encodeURIComponent(id) + '/status')`.

### createMtlsReplicaClient → reloadTokens

`reloadTokens(assertion, options = {})` · [Dòng 322–339](../../../src/cloud-replica-mtls.mjs#L322)

- Lời gọi trong thân hàm: `Array.isArray`, `VERSION.test`, `ROLLOUT_ID.test`, `Object.keys`, `request`, `encodeURIComponent`.
- Kết quả: `request(…)`.
- Lỗi trực tiếp có thông điệp cố định: `A valid signed replica assertion is required`, `Replica reload constraints do not match this client identity`.
