# egress-proxy.mjs

[Mở module nguồn](../../../src/egress-proxy.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### response

`response(socket, status, reason, message)` · [Dòng 12–19](../../../src/egress-proxy.mjs#L12)

- Lời gọi trong thân hàm: `socket.end`, `Buffer.byteLength`.
- Kết quả: `void`.

### publicHostname

`publicHostname(input)` · [Dòng 21–33](../../../src/egress-proxy.mjs#L21)

- Lời gọi trong thân hàm: `input.endsWith`, `input.includes`, `isIP`, `domainToASCII`, `input.toLowerCase`, `host.includes`, `host.split`, `labels.some`, `BLOCKED_SUFFIXES.some`.
- Kết quả: `null`, `host`.

### parseConnectRequest

`parseConnectRequest(raw)` · [Dòng 35–67](../../../src/egress-proxy.mjs#L35)

- Lời gọi trong thân hàm: `raw.split`, `lines.shift`, `publicHostname`, `Number`, `Number.isInteger`, `/^[ \t]/.test`, `match[1].toLowerCase`, `headers.has`, `headers.set`, `match[2].trim`, `headers.get`, `[host, host + ':443'].includes`, `hostHeader.toLowerCase`.
- Kết quả: `{error}`, `{host, port}`.

### createEgressProxyServer

`createEgressProxyServer({ resolve = lookup, connect = tcpConnect, blockedIp = isBlockedIp, maxConnections = 64, maxHeaderBytes = 8192, connectTimeoutMs = 10000, idleTimeoutMs = 120000, } = {})` · [Dòng 78–195](../../../src/egress-proxy.mjs#L78)

- Lời gọi trong thân hàm: `Object.entries`, `Number.isSafeInteger`, `createServer`, `server.close.bind`.
- Kết quả: `server`.

### createEgressProxyServer → onHeader

`onHeader(chunk)` · [Dòng 108–184](../../../src/egress-proxy.mjs#L108)

- Lời gọi trong thân hàm: `Buffer.concat`, `client.removeListener`, `response`, `received.indexOf`, `client.pause`, `received.subarray`, `parseConnectRequest`.
- Kết quả: `void`.

### createEgressProxyServer → close

`close(callback)` · [Dòng 189–193](../../../src/egress-proxy.mjs#L189)

- Lời gọi trong thân hàm: `socket.destroy`, `closeServer`.
- Kết quả: `closeServer(callback)`.
