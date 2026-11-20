# cloud-auth.mjs

[Mở module nguồn](../../../src/cloud-auth.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### positiveInteger

`positiveInteger(value, fallback, name)` · [Dòng 8–14](../../../src/cloud-auth.mjs#L8)

- Lời gọi trong thân hàm: `Number.isSafeInteger`.
- Kết quả: `resolved`.

### compileTokenRegistry

`compileTokenRegistry(entries, { allowEmpty = false } = {})` · [Dòng 16–64](../../../src/cloud-auth.mjs#L16)

- Lời gọi trong thân hàm: `Array.isArray`, `TOKEN.test`, `ID.test`, `entry.projectIds.every`, `createHash`, `digest.toString`, `registry.has`, `key.slice`, `tokenIds.has`, `[...entry.projectIds].sort`, `JSON.stringify`, `principalScopes.has`, `principalScopes.get`, `principalScopes.set`, `Number.isFinite`, `Date.parse`, `tokenIds.add`, `registry.set`, `Object.freeze`.
- Kết quả: `registry`.
- Lỗi trực tiếp có thông điệp cố định: `Cloud mode requires at least one configured bearer token`, `Each cloud token requires a 32+ character token, tenantId and unique projectIds`, `Duplicate cloud bearer token`, `Cloud token principalId and tokenId must be valid identifiers`, `Duplicate cloud tokenId`, `All credentials for a principal must share the same tenant and project ACL`, `Cloud token expiresAt must be a valid ISO date string`.

### safeTokenSnapshot

`safeTokenSnapshot(registry)` · [Dòng 66–72](../../../src/cloud-auth.mjs#L66)

- Lời gọi trong thân hàm: `Object.freeze`, `registry.values`.
- Kết quả: `Object.freeze(…)`.

### createCloudAuth

`createCloudAuth({ tokens, limits = {}, clock = Date.now } = {})` · [Dòng 80–202](../../../src/cloud-auth.mjs#L80)

- Lời gọi trong thân hàm: `compileTokenRegistry`, `Object.freeze`, `positiveInteger`.
- Kết quả: `{limits, authenticate, authorizeProject, consumeRequest, checkJobQuota, tokenSnapshot, validateTokens, replaceTokens, revokeToken, revokePrincipal}`.

### createCloudAuth → authenticate

`authenticate(req)` · [Dòng 92–109](../../../src/cloud-auth.mjs#L92)

- Lời gọi trong thân hàm: `createHash`, `clock`, `Buffer.from`, `timingSafeEqual`.
- Kết quả: `null`, `authenticated`.

### createCloudAuth → authorizeProject

`authorizeProject(principal, projectId)` · [Dòng 111–119](../../../src/cloud-auth.mjs#L111)

- Lời gọi trong thân hàm: `ID.test`, `principal.projectIds.includes`, `Object.freeze`.
- Kết quả: `null`, `{principalId, tenantId, projectId}`.

### createCloudAuth → replaceTokens

`replaceTokens(nextTokens)` · [Dòng 121–125](../../../src/cloud-auth.mjs#L121)

- Lời gọi trong thân hàm: `compileTokenRegistry`, `safeTokenSnapshot`.
- Kết quả: `safeTokenSnapshot(principals)`.

### createCloudAuth → revokeToken

`revokeToken(tokenId)` · [Dòng 127–136](../../../src/cloud-auth.mjs#L127)

- Lời gọi trong thân hàm: `ID.test`, `principals.delete`, `safeTokenSnapshot`.
- Kết quả: `null`, `safeTokenSnapshot(new Map([[digest, principal]])).at(0)`.

### createCloudAuth → revokePrincipal

`revokePrincipal(principalId)` · [Dòng 138–148](../../../src/cloud-auth.mjs#L138)

- Lời gọi trong thân hàm: `ID.test`, `revoked.push`, `principals.delete`, `safeTokenSnapshot`, `revoked.map`.
- Kết quả: `[]`, `safeTokenSnapshot(new Map(revoked.map((principal, index) => [String(index), principal])))`.

### createCloudAuth → consumeRequest

`consumeRequest(principal, store = null)` · [Dòng 150–169](../../../src/cloud-auth.mjs#L150)

- Lời gọi trong thân hàm: `clock`, `store.consumeCloudRequest`, `requests.get`, `requests.set`, `Math.max`, `Math.ceil`, `recent.push`.
- Kết quả: `store.consumeCloudRequest( principal.tenantId, now, WINDOW_MS, configuredLimits.maxRequestsPerMinute, )`, `{allowed, retryAfterSeconds}`.

### createCloudAuth → checkJobQuota

`checkJobQuota(jobs, principal, now = clock(), persistedDailyCount = null)` · [Dòng 171–188](../../../src/cloud-auth.mjs#L171)

- Lời gọi trong thân hàm: `jobs.filter`, `tenantJobs.filter`, `Number.isSafeInteger`.
- Kết quả: `{allowed, reason}`.

### createCloudAuth → tokenSnapshot

`tokenSnapshot()` · [Dòng 196–196](../../../src/cloud-auth.mjs#L196)

- Lời gọi trong thân hàm: `safeTokenSnapshot`.
- Kết quả: `safeTokenSnapshot(principals)`.

### createCloudAuth → validateTokens

`validateTokens(nextTokens)` · [Dòng 197–197](../../../src/cloud-auth.mjs#L197)

- Lời gọi trong thân hàm: `safeTokenSnapshot`, `compileTokenRegistry`.
- Kết quả: `safeTokenSnapshot(compileTokenRegistry(nextTokens, { allowEmpty: true }))`.
