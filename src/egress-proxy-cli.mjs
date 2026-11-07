import { createEgressProxyServer } from './egress-proxy.mjs';

const host = process.env.EGRESS_PROXY_HOST || '127.0.0.1';
const port = Number(process.env.EGRESS_PROXY_PORT || 3128);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('EGRESS_PROXY_PORT must be an integer from 1 to 65535');
}

const server = createEgressProxyServer({
  maxConnections: Number(process.env.EGRESS_PROXY_MAX_CONNECTIONS || 64),
});
server.listen(port, host, () => {
  process.stderr.write('Egress proxy listening on ' + host + ':' + port + '\n');
});

function shutdown() {
  server.close();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
