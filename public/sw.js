const CACHE="cn-v2";
const SHELL=["/","/index.html","/manifest.json","/icon-192.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener("fetch",e=>{
  const r=e.request,u=new URL(r.url);
  if(r.method!=="GET")return;
  const own=u.origin===location.origin,libs=u.hostname==="cdnjs.cloudflare.com";
  if(own&&u.pathname.startsWith("/api/"))return; /* données et photos : toujours le serveur */
  if(own&&r.mode==="navigate"){e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(CACHE).then(x=>x.put(r,cp));return res}).catch(()=>caches.match("/index.html")));return}
  if(!own&&!libs)return; /* tuiles de carte : toujours le réseau */
  e.respondWith(caches.match(r).then(c=>{
    const net=fetch(r).then(res=>{if(res&&(res.ok||res.type==="opaque")){const cp=res.clone();caches.open(CACHE).then(x=>x.put(r,cp))}return res}).catch(()=>c);
    return c||net;
  }));
});
