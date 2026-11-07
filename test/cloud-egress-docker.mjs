import { execFileSync } from 'node:child_process';

const suffix = String(process.pid);
const image = 'url-to-tutorial-egress-proxy:ci-' + suffix;
const egressNetwork = 'utv-egress-ci-' + suffix;
const workerNetwork = 'utv-worker-ci-' + suffix;
const proxyContainer = 'utv-egress-proxy-ci-' + suffix;
const run = (args, options = {}) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: options.stdio || 'pipe', timeout: options.timeout || 120000,
});

try {
  run(['info'], { timeout: 15000 });
} catch {
  process.stdout.write('SKIP cloud egress Docker test: Docker daemon is unavailable\n');
  process.exit(0);
}

try {
  run(['build', '-f', 'Dockerfile.egress-proxy', '-t', image, '.'], { stdio: 'inherit', timeout: 180000 });
  run(['network', 'create', '--driver', 'bridge', egressNetwork]);
  run(['run', '--detach', '--init', '--name', proxyContainer, '--network', egressNetwork,
    '--env', 'EGRESS_PROXY_HOST=0.0.0.0', '--env', 'EGRESS_PROXY_PORT=3128',
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--pids-limit=64', '--memory=128m', '--cpus=0.5',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', image]);
  run(['network', 'create', '--internal', '--driver', 'bridge', workerNetwork]);
  run(['network', 'connect', '--alias', 'egress-proxy', workerNetwork, proxyContainer]);
  const readyProbe = `
    const net=require('node:net');
    let attempts=0;
    const tryConnect=()=>{
      const socket=net.connect(3128,'egress-proxy');
      socket.once('connect',()=>{socket.destroy();process.exit(0)});
      socket.once('error',()=>{socket.destroy();if(++attempts>=30)process.exit(1);setTimeout(tryConnect,200)});
    };
    tryConnect();
  `;
  run(['run', '--rm', '--network', workerNetwork, '--entrypoint', 'node', image, '-e', readyProbe],
    { timeout: 10000 });

  const directProbe = `
    const net=require('node:net');
    const socket=net.connect({host:'1.1.1.1',port:443});
    let finished=false;
    const end=code=>{if(finished)return;finished=true;socket.destroy();process.exit(code)};
    socket.setTimeout(1800);
    socket.once('connect',()=>end(2));
    socket.once('timeout',()=>end(0));
    socket.once('error',()=>end(0));
    setTimeout(()=>end(0),2200);
  `;
  run(['run', '--rm', '--network', workerNetwork, '--entrypoint', 'node', image, '-e', directProbe],
    { timeout: 10000 });

  const proxiedProbe = `
    const net=require('node:net'),tls=require('node:tls');
    const socket=net.connect(3128,'egress-proxy');
    let header=Buffer.alloc(0),finished=false;
    const fail=code=>{if(finished)return;finished=true;socket.destroy();process.exit(code)};
    const timer=setTimeout(()=>fail(8),12000);
    socket.once('connect',()=>socket.write('CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n'));
    const onData=chunk=>{
      header=Buffer.concat([header,chunk]);
      const end=header.indexOf('\\r\\n\\r\\n');
      if(end<0)return;
      const response=header.subarray(0,end).toString('latin1');
      if(!/^HTTP\\/1\\.1 200 /.test(response)){clearTimeout(timer);fail(3);return}
      const remainder=header.subarray(end+4);
      socket.removeListener('data',onData);
      const secure=tls.connect({socket,servername:'example.com',rejectUnauthorized:true});
      secure.on('error',()=>{clearTimeout(timer);fail(4)});
      secure.once('secureConnect',()=>{
        secure.write('GET / HTTP/1.1\\r\\nHost: example.com\\r\\nConnection: close\\r\\n\\r\\n');
      });
      let responseText='';
      secure.on('data',chunk=>{
        responseText+=chunk.toString('latin1');
        const split=responseText.indexOf('\\r\\n\\r\\n');
        if(split>=0){
          const status=responseText.slice(0,split).split('\\r\\n')[0];
          clearTimeout(timer);
          if(/^HTTP\\/1\\.[01] 200 /.test(status))fail(0);else fail(5);
        }
      });
    };
    socket.on('data',onData);
    socket.once('error',()=>{clearTimeout(timer);fail(6)});
  `;
  run(['run', '--rm', '--network', workerNetwork, '--entrypoint', 'node', image, '-e', proxiedProbe],
    { timeout: 20000 });

  const privateProbe = `
    const net=require('node:net');
    const socket=net.connect(3128,'egress-proxy');
    let data='';
    const timer=setTimeout(()=>{socket.destroy();process.exit(3)},3000);
    socket.once('connect',()=>socket.write('CONNECT localhost:443 HTTP/1.1\\r\\nHost: localhost:443\\r\\n\\r\\n'));
    socket.on('data',chunk=>{data+=chunk.toString();if(data.includes('\\r\\n\\r\\n')){clearTimeout(timer);socket.destroy();process.exit(/^HTTP\\/1\\.1 403 /.test(data)?0:4)}});
    socket.once('error',()=>{clearTimeout(timer);process.exit(5)});
  `;
  run(['run', '--rm', '--network', workerNetwork, '--entrypoint', 'node', image, '-e', privateProbe],
    { timeout: 10000 });

  process.stdout.write('PASS: worker network blocks direct internet, allows public HTTPS only through proxy, and rejects localhost CONNECT\n');
} finally {
  try { run(['rm', '-f', proxyContainer]); } catch {}
  try { run(['network', 'rm', workerNetwork]); } catch {}
  try { run(['network', 'rm', egressNetwork]); } catch {}
  try { run(['image', 'rm', image]); } catch {}
}
