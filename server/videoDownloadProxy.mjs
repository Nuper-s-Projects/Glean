import { createServer, request as httpRequest } from 'node:http';
import { lookup } from 'node:dns/promises';
import { BlockList, connect, isIP } from 'node:net';
import { randomBytes } from 'node:crypto';

const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) denied.addSubnet(address,prefix,'ipv4');
denied.addSubnet('2001::',23,'ipv6');
denied.addSubnet('2001:db8::',32,'ipv6');
denied.addSubnet('2002::',16,'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::',3,'ipv6');

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !denied.check(address,'ipv4')
    : family === 6 && globalV6.check(address,'ipv6') && !denied.check(address,'ipv6');
}

export async function publicDestination(host, resolver = lookup) {
  if (!host || host.length > 253 || /[\s%@/\\]/.test(host)) throw new Error('Invalid destination.');
  let timer;
  try {
    const records = await Promise.race([resolver(host,{all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS timeout.')),5000);timer.unref?.();})]);
    if (!records.length || records.some(record=>!isPublicAddress(record.address))) throw new Error('Private network destinations are not allowed.');
    return records.find(record=>record.family===4) || records[0];
  } finally { clearTimeout(timer); }
}

// Every request and CONNECT resolves again, then connects to the validated IP.
// Redirects cannot reach private networks or exploit DNS rebinding.
export async function createDownloadProxy({ maxBytes = 650 * 1024 * 1024 } = {}) {
  const token = randomBytes(24).toString('hex');
  const authorization = `Basic ${Buffer.from(`${token}:x`).toString('base64')}`;
  const sockets = new Set();
  let transferred = 0, stopped = false;
  const track = socket => {
    sockets.add(socket);
    socket.setTimeout(30_000,()=>socket.destroy());
    socket.on('close',()=>sockets.delete(socket));
    socket.on('error',()=>{});
    socket.on('data',chunk=>{
      transferred += chunk.length;
      if (transferred > maxBytes) for (const item of sockets) item.destroy();
    });
    return socket;
  };
  const allowed = request => !stopped && sockets.size < 20 && transferred <= maxBytes && request.headers['proxy-authorization'] === authorization;
  const server = createServer(async(request,response)=>{
    try {
      if (!allowed(request)) throw new Error('Proxy access denied.');
      const target = new URL(request.url);
      if (target.protocol !== 'http:' || target.username || target.password || (target.port && target.port !== '80')) throw new Error('Unsupported destination.');
      const destination = await publicDestination(target.hostname);
      if (stopped) throw new Error('Proxy closed.');
      const headers = {...request.headers,host:target.host};
      for (const name of ['proxy-authorization','proxy-connection','connection','upgrade']) delete headers[name];
      const upstream = httpRequest({host:destination.address,family:destination.family,port:80,method:request.method,path:target.pathname+target.search,headers,agent:false},result=>{
        response.writeHead(result.statusCode,result.headers);
        result.pipe(response);
      });
      upstream.on('socket',track);
      upstream.on('error',()=>{ if(!response.headersSent)response.writeHead(502);response.end(); });
      response.on('close',()=>upstream.destroy());
      request.pipe(upstream);
    } catch { response.writeHead(403);response.end('Destination denied.'); }
  });
  server.on('connect',async(request,client,head)=>{
    try {
      if (!allowed(request)) throw new Error('Proxy access denied.');
      const target = new URL(`https://${request.url}`);
      if (target.username || target.password || target.port || target.pathname !== '/' || !request.url.endsWith(':443')) throw new Error('Unsupported tunnel.');
      const destination = await publicDestination(target.hostname);
      if (stopped) throw new Error('Proxy closed.');
      const upstream = track(connect({host:destination.address,family:destination.family,port:443}));
      client.on('close',()=>upstream.destroy());
      upstream.on('close',()=>client.destroy());
      upstream.once('connect',()=>{
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if(head.length)upstream.write(head);
        client.pipe(upstream);upstream.pipe(client);
      });
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  server.on('connection',track);
  server.on('clientError',(_,socket)=>socket.destroy());
  server.maxConnections = 20;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {
    url:`http://${token}:x@127.0.0.1:${server.address().port}`,
    close(){stopped=true;for(const socket of sockets)socket.destroy();server.close();},
  };
}
