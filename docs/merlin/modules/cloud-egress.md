# cloud-egress.mjs

[Mở module nguồn](../../../src/cloud-egress.mjs). Mỗi mục trỏ tới dòng trong snapshot của ZIP. Chữ ký lấy từ cây cú pháp ECMAScript. Phần “Lời gọi” liệt kê theo thứ tự xuất hiện trong thân hàm; các nhánh và callback có thể chạy ở thời điểm khác nhau. Giá trị trả về dưới đây là các dạng biểu thức trong source; với hàm async, caller nhận Promise.

### ipv4Value

`ipv4Value(input)` · [Dòng 4–7](../../../src/cloud-egress.mjs#L4)

- Lời gọi trong thân hàm: `isIP`, `input.split`.
- Kết quả: `null`, `input.split('.').reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n)`.

### ipv6Value

`ipv6Value(input)` · [Dòng 9–28](../../../src/cloud-egress.mjs#L9)

- Lời gọi trong thân hàm: `isIP`, `input.includes`, `input.toLowerCase`, `address.includes`, `address.lastIndexOf`, `ipv4Value`, `address.slice`, `address.split`, `halves[0].split`, `halves[1].split`, `Array`, `groups.some`, `groups.reduce`.
- Kết quả: `null`, `groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n)`.

### inCidr

`inCidr(value, network, prefix, bits)` · [Dòng 30–33](../../../src/cloud-egress.mjs#L30)

- Lời gọi trong thân hàm: `BigInt`.
- Kết quả: `(value >> shift) === (network >> shift)`.

### isBlockedIp

`isBlockedIp(input)` · [Dòng 54–70](../../../src/cloud-egress.mjs#L54)

- Lời gọi trong thân hàm: `String`, `ipv4Value`, `IPV4_BLOCKED.some`, `ipv6Value`, `inCidr`, `IPV6_BLOCKED.some`.
- Kết quả: `IPV4_BLOCKED.some(([network, prefix]) => inCidr(v4, network, prefix, 32))`, `true`, `IPV4_BLOCKED.some(([network, prefix]) => inCidr(mappedV4, network, prefix, 32))`, `IPV6_BLOCKED.some(([network, prefix]) => inCidr(v6, network, prefix, 128))`.

### publicUrlPreflight

`publicUrlPreflight(value, resolve = lookup)` · [Dòng 76–97](../../../src/cloud-egress.mjs#L76)

- Lời gọi trong thân hàm: `url.hostname.toLowerCase`, `host.endsWith`, `isIP`, `resolve`, `addresses.some`.
- Kết quả: `url.href`.
- Lỗi trực tiếp có thông điệp cố định: `Invalid public URL`, `Hosted mode requires HTTPS, standard port and no credentials`, `Local or reserved hostnames are not permitted for cloud egress`, `Private, reserved, or unresolvable destination is prohibited`.
