import assert from 'node:assert/strict';
import { request } from 'node:http';
import { isPublicAddress, publicDestination, createDownloadProxy } from '../server/videoDownloadProxy.mjs';
import { validateVideoUrl } from '../server/videoDownloads.mjs';

for(const url of ['https://www.youtube.com/watch?v=test','https://youtu.be/test','https://www.tiktok.com/@user/video/123','https://vimeo.com/123','https://example.com/clip.mp4'])assert.ok(validateVideoUrl(url));
for(const url of ['http://youtube.com/x','https://youtube.com.evil.test/x','https://youtube.com@127.0.0.1/x','https://youtube.com:8443/x','https://127.0.0.1/x','https://169.254.169.254/latest/meta-data','https://127.0.0.1/clip.mp4','https://[::1]/clip.mp4','https://localhost/clip.mp4','https://anything.internal/clip.mp4','file:///etc/passwd','--exec bad',null])assert.throws(()=>validateVideoUrl(url));
for(const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','100.64.0.1','0.0.0.0','198.18.1.1','192.0.2.1','224.0.0.1','::1','fe80::1','fc00::1','::ffff:127.0.0.1','2002:7f00:1::','2001:db8::1'])assert.equal(isPublicAddress(address),false,address);
for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(isPublicAddress(address),true,address);
await assert.rejects(publicDestination('mixed.test',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));
await assert.rejects(publicDestination('private.test',async()=>[{address:'169.254.169.254',family:4}]));
const proxy=await createDownloadProxy(),url=new URL(proxy.url);
const auth='Basic '+Buffer.from(`${url.username}:${url.password}`).toString('base64');
const probe=(path,authorization=auth,method='GET')=>new Promise((resolve,reject)=>{
 const req=request({host:'127.0.0.1',port:url.port,path,method,headers:{'Proxy-Authorization':authorization}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
 req.on('connect',(res,socket)=>{socket.destroy();resolve(res.statusCode);});req.on('error',reject);req.end();
});
try {
 assert.equal(await probe('http://127.0.0.1:80/'),403);
 assert.equal(await probe('http://169.254.169.254/latest/meta-data'),403);
 assert.equal(await probe('http://localhost/'),403);
 assert.equal(await probe('localhost:443',auth,'CONNECT'),403);
 assert.equal(await probe('example.com:22',auth,'CONNECT'),403);
 assert.equal(await probe('http://example.com/','wrong'),403);
}finally {proxy.close();}
console.log('PASS download URL allowlist, IPv4/IPv6 private network denial, mixed DNS denial, authenticated HTTP proxy and CONNECT private/port guards.');
