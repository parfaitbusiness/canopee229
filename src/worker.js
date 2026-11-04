/* CANOPÉE 229 : serveur (Cloudflare Worker + base D1). Aucune clé n'est écrite ici :
   OWNER_EMAIL, OWNER_PASSWORD et SESSION_SECRET se règlent dans Cloudflare (Secrets). */
const SCHEMA=[
"CREATE TABLE IF NOT EXISTS zones(id TEXT PRIMARY KEY,nom TEXT NOT NULL UNIQUE,surface_km2 REAL,created_at TEXT DEFAULT (datetime('now')))",
"CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY,data TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')))",
"CREATE TABLE IF NOT EXISTS arbres(id TEXT PRIMARY KEY,espece TEXT NOT NULL,date_plantation TEXT NOT NULL,lat REAL NOT NULL,lng REAL NOT NULL,zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,etat TEXT NOT NULL DEFAULT 'vivant',taille_cm INTEGER,besoin_eau TEXT NOT NULL DEFAULT 'inconnu',responsable TEXT,photo_id TEXT,created_at TEXT DEFAULT (datetime('now')))",
"CREATE TABLE IF NOT EXISTS visites(id TEXT PRIMARY KEY,arbre_id TEXT NOT NULL REFERENCES arbres(id) ON DELETE CASCADE,date_visite TEXT NOT NULL DEFAULT (date('now')),etat TEXT NOT NULL,taille_cm INTEGER,commentaire TEXT,photo_id TEXT,auteur TEXT,valide INTEGER NOT NULL DEFAULT 0,created_at TEXT DEFAULT (datetime('now')))",
"CREATE TABLE IF NOT EXISTS parrainages(id TEXT PRIMARY KEY,arbre_id TEXT NOT NULL REFERENCES arbres(id) ON DELETE CASCADE,type_parrain TEXT NOT NULL,nom TEXT NOT NULL,contact TEXT NOT NULL,afficher_nom INTEGER NOT NULL DEFAULT 0,valide INTEGER NOT NULL DEFAULT 0,created_at TEXT DEFAULT (datetime('now')))",
"CREATE TABLE IF NOT EXISTS signalements(id TEXT PRIMARY KEY,type TEXT NOT NULL,description TEXT NOT NULL,lat REAL NOT NULL,lng REAL NOT NULL,photo_id TEXT,contact TEXT,consentement_contact INTEGER NOT NULL DEFAULT 0,traite INTEGER NOT NULL DEFAULT 0,created_at TEXT DEFAULT (datetime('now')))",
"CREATE TABLE IF NOT EXISTS rl(k TEXT PRIMARY KEY,n INTEGER NOT NULL,exp INTEGER NOT NULL)"];
const ETATS=["vivant","souffrance","mort"],EAU=["faible","moyen","eleve","inconnu"],TYPES=["non_repertorie","danger","emplacement"],PARR=["individuel","ecole","entreprise"];
const enc=new TextEncoder();
const J=(d,s=200,h={})=>new Response(JSON.stringify(d),{status:s,headers:{"Content-Type":"application/json;charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...h}});
const bad=m=>J({error:m},400);
let READY=null;
const ready=env=>READY||(READY=env.DB.batch(SCHEMA.map(s=>env.DB.prepare(s))).catch(e=>{READY=null;throw e}));
const uid=()=>crypto.randomUUID();
const txt=(v,min,max)=>{if(v===null||v===undefined||v==="")return min>0?undefined:null;if(typeof v!=="string")return undefined;const s=v.trim();return s.length>=min&&s.length<=max?(s||null):undefined};
const num=(v,a,b)=>v===null||v===undefined||v===""?null:(Number.isFinite(+v)&&+v>=a&&+v<=b?+v:undefined);
const inBenin=(la,ln)=>Number.isFinite(la)&&Number.isFinite(ln)&&la>=6&&la<=12.6&&ln>=0.7&&ln<=3.9;
const day=()=>new Date().toISOString().slice(0,10);
async function sha(s){return new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(s)))}
async function same(a,b){const x=await sha(String(a)),y=await sha(String(b));let d=0;for(let i=0;i<32;i++)d|=x[i]^y[i];return d===0}
const b64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
async function hmac(env,s){const k=await crypto.subtle.importKey("raw",enc.encode(env.SESSION_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return b64u(await crypto.subtle.sign("HMAC",k,enc.encode(s)))}
async function mkToken(env){const p=b64u(enc.encode(JSON.stringify({exp:Date.now()+12*36e5})));return p+"."+await hmac(env,p)}
async function isOwner(env,req){if(!env.SESSION_SECRET)return false;const t=(req.headers.get("Authorization")||"").replace(/^Bearer /,""),[p,s]=t.split(".");if(!p||!s)return false;if(!await same(s,await hmac(env,p)))return false;try{return JSON.parse(atob(p.replace(/-/g,"+").replace(/_/g,"/"))).exp>Date.now()}catch(_){return false}}
async function limit(env,req,act,max,sec){const ip=req.headers.get("CF-Connecting-IP")||"local",k=[...(await sha(ip+act)).slice(0,8)].map(b=>b.toString(16).padStart(2,"0")).join(""),now=Math.floor(Date.now()/1000);
const r=await env.DB.prepare("INSERT INTO rl(k,n,exp) VALUES(?1,1,?2) ON CONFLICT(k) DO UPDATE SET n=CASE WHEN exp<?3 THEN 1 ELSE n+1 END,exp=CASE WHEN exp<?3 THEN ?2 ELSE exp END RETURNING n").bind(k+act,now+sec,now).first();return r.n<=max}
async function json(req){const t=await req.text();if(t.length>20000)throw new Error("trop volumineux");try{return JSON.parse(t)}catch(_){throw new Error("JSON invalide")}}
const st=m=>`(SELECT v.etat FROM visites v WHERE v.arbre_id=a.id AND v.valide=1 AND v.date_visite BETWEEN date(a.date_plantation,'+${m} months','-15 days') AND date(a.date_plantation,'+${m} months','+45 days') ORDER BY v.date_visite LIMIT 1)`;
const LAST="COALESCE((SELECT etat FROM visites WHERE arbre_id=a.id AND valide=1 ORDER BY date_visite DESC,created_at DESC LIMIT 1),a.etat)";
const SQL_ARBRES=`SELECT a.id,a.espece,a.date_plantation,a.lat,a.lng,a.besoin_eau,a.responsable,z.nom AS zone,
COALESCE(v.etat,a.etat) AS etat,COALESCE(v.taille_cm,a.taille_cm) AS taille_cm,COALESCE(v.photo_id,a.photo_id) AS photo_id,v.date_visite AS derniere_visite,
(SELECT COUNT(*) FROM visites x WHERE x.arbre_id=a.id AND x.valide=1) AS nb_visites,
CASE WHEN p.id IS NULL THEN 0 ELSE 1 END AS parraine,p.type_parrain,CASE WHEN p.afficher_nom=1 THEN p.nom END AS parrain_nom
FROM arbres a LEFT JOIN zones z ON z.id=a.zone_id
LEFT JOIN visites v ON v.id=(SELECT id FROM visites WHERE arbre_id=a.id AND valide=1 ORDER BY date_visite DESC,created_at DESC LIMIT 1)
LEFT JOIN parrainages p ON p.id=(SELECT id FROM parrainages WHERE arbre_id=a.id AND valide=1 ORDER BY created_at LIMIT 1)`;
const SQL_TSAP=`SELECT z.id,z.nom,z.surface_km2,
(SELECT COUNT(*) FROM arbres a WHERE a.zone_id=z.id) AS total,
(SELECT COUNT(*) FROM arbres a WHERE a.zone_id=z.id AND ${LAST}<>'mort') AS vivants,
${[3,6,12].map(m=>`(SELECT COUNT(*) FROM arbres a WHERE a.zone_id=z.id AND ${st(m)} IS NOT NULL) AS n${m},(SELECT COUNT(*) FROM arbres a WHERE a.zone_id=z.id AND ${st(m)} IN ('vivant','souffrance')) AS v${m}`).join(",")}
FROM zones z ORDER BY z.nom`;
const withPhoto=r=>({...r,photo_url:r.photo_id?"/api/photo/"+r.photo_id:null});
async function route(req,env,u){
  const p=u.pathname,m=req.method;
  if(!env.DB)return J({error:"La base D1 n'est pas reliée : vérifie database_id dans wrangler.jsonc."},503);
  await ready(env);
  if(p==="/api/sante")return J({ok:true,base:"reliée",identifiants:{email:!!env.OWNER_EMAIL,motdepasse:!!env.OWNER_PASSWORD,session:!!env.SESSION_SECRET}});
  if(m==="GET"&&p==="/api/arbres")return J((await env.DB.prepare(SQL_ARBRES).all()).results.map(withPhoto),200,{"Cache-Control":"public,max-age=20"});
  if(m==="GET"&&p==="/api/zones")return J((await env.DB.prepare("SELECT id,nom,surface_km2 FROM zones ORDER BY nom").all()).results);
  if(m==="GET"&&p==="/api/tsap")return J((await env.DB.prepare(SQL_TSAP).all()).results);
  if(m==="GET"&&p.startsWith("/api/photo/")){const r=await env.DB.prepare("SELECT data FROM photos WHERE id=?").bind(p.slice(11)).first();if(!r)return new Response("Introuvable",{status:404});return new Response(Uint8Array.from(atob(r.data),c=>c.charCodeAt(0)),{headers:{"Content-Type":"image/jpeg","Cache-Control":"public,max-age=86400","X-Content-Type-Options":"nosniff"}})}
  if(m==="POST"&&p==="/api/login"){
    if(!env.OWNER_EMAIL||!env.OWNER_PASSWORD||!env.SESSION_SECRET)return J({error:"Les identifiants du propriétaire ne sont pas encore enregistrés dans Cloudflare (Secrets)."},503);
    if(!await limit(env,req,"login",8,900))return J({error:"Trop de tentatives. Réessaie dans 15 minutes."},429);
    let b;try{b=await json(req)}catch(e){return bad(e.message)}
    const a=await same(String(b.email||"").trim().toLowerCase(),env.OWNER_EMAIL.trim().toLowerCase()),c=await same(String(b.password||""),env.OWNER_PASSWORD);
    if(!(a&&c))return J({error:"Email ou mot de passe incorrect."},401);
    return J({token:await mkToken(env)});
  }
  /* Envois publics : limités par adresse (hachée), jamais publiés avant validation */
  if(m==="POST"&&["/api/photos","/api/signalements","/api/visites","/api/parrainages"].includes(p)){
    if(!await limit(env,req,"pub",30,3600))return J({error:"Trop d'envois. Réessaie plus tard."},429);
    if(p==="/api/photos")return savePhoto(req,env);
    let b;try{b=await json(req)}catch(e){return bad(e.message)}
    return p==="/api/signalements"?addSignal(env,b):p==="/api/visites"?addVisite(env,b,false):addParrain(env,b);
  }
  /* Espace propriétaire */
  if(p.startsWith("/api/equipe/")){
    if(!await isOwner(env,req))return J({error:"Session expirée ou non connectée."},401);
    if(m==="GET"&&p==="/api/equipe/ping")return J({ok:true});
    if(m==="GET"&&p==="/api/equipe/pending"){
      const v=(await env.DB.prepare("SELECT v.*,a.espece FROM visites v JOIN arbres a ON a.id=v.arbre_id WHERE v.valide=0 ORDER BY v.created_at").all()).results.map(withPhoto),
      pa=(await env.DB.prepare("SELECT p.*,a.espece FROM parrainages p JOIN arbres a ON a.id=p.arbre_id WHERE p.valide=0 ORDER BY p.created_at").all()).results,
      s=(await env.DB.prepare("SELECT * FROM signalements WHERE traite=0 ORDER BY created_at").all()).results.map(withPhoto);
      return J({visites:v,parrainages:pa,signalements:s});
    }
    if(p==="/api/equipe/photos"&&m==="POST")return savePhoto(req,env);
    if(m!=="POST")return J({error:"Méthode non autorisée"},405);
    if(p==="/api/equipe/save-photo")return J({error:"inconnu"},404);
    let b;try{b=await json(req)}catch(e){return bad(e.message)}
    if(p==="/api/equipe/arbres")return addArbre(env,b);
    if(p==="/api/equipe/visites")return addVisite(env,b,true);
    if(p==="/api/equipe/zones"){const nom=txt(b.nom,2,80),s=num(b.surface_km2,0.01,100000);if(!nom||s===undefined)return bad("Nom de zone ou surface invalide.");try{await env.DB.prepare("INSERT INTO zones(id,nom,surface_km2) VALUES(?,?,?)").bind(uid(),nom,s).run()}catch(_){return bad("Cette zone existe déjà.")}return J({ok:true})}
    if(p==="/api/equipe/valider"||p==="/api/equipe/rejeter"){
      const t=b.t,id=String(b.id||"");if(!["visites","parrainages","signalements"].includes(t)||!id)return bad("Demande invalide.");
      if(p.endsWith("valider")){const r=await env.DB.prepare(t==="signalements"?"UPDATE signalements SET traite=1 WHERE id=?":`UPDATE ${t} SET valide=1 WHERE id=?`).bind(id).run();return r.meta.changes?J({ok:true}):J({error:"Élément introuvable."},404)}
      const row=t==="parrainages"?null:await env.DB.prepare(`SELECT photo_id FROM ${t} WHERE id=?`).bind(id).first(),r=await env.DB.prepare(`DELETE FROM ${t} WHERE id=?`).bind(id).run();
      if(row&&row.photo_id)await env.DB.prepare("DELETE FROM photos WHERE id=? AND id NOT IN (SELECT photo_id FROM arbres WHERE photo_id IS NOT NULL UNION SELECT photo_id FROM visites WHERE photo_id IS NOT NULL UNION SELECT photo_id FROM signalements WHERE photo_id IS NOT NULL)").bind(row.photo_id).run();
      return r.meta.changes?J({ok:true}):J({error:"Élément introuvable."},404)}
  }
  return J({error:"Introuvable"},404);
}
async function savePhoto(req,env){const buf=new Uint8Array(await req.arrayBuffer());if(buf.length<500||buf.length>700000)return bad("Photo trop grande ou invalide.");if(!(buf[0]===255&&buf[1]===216&&buf[2]===255))return bad("Seules les photos JPEG sont acceptées.");let s="";for(let i=0;i<buf.length;i+=32768)s+=String.fromCharCode(...buf.subarray(i,i+32768));const id=uid();await env.DB.prepare("INSERT INTO photos(id,data) VALUES(?,?)").bind(id,btoa(s)).run();return J({id})}
const photoOk=async(env,id)=>{if(id===null||id===undefined||id==="")return null;if(typeof id!=="string")return undefined;return (await env.DB.prepare("SELECT 1 x FROM photos WHERE id=?").bind(id).first())?id:undefined};
async function addSignal(env,b){const d=txt(b.description,10,500),c=txt(b.contact,0,120),la=+b.lat,ln=+b.lng,ph=await photoOk(env,b.photo_id);
  if(!TYPES.includes(b.type)||d===undefined||!d||c===undefined||!inBenin(la,ln)||ph===undefined)return bad("Signalement invalide : vérifie le type, la description et la position.");if(c&&b.consentement_contact!==true)return bad("L'accord de contact est nécessaire pour laisser un contact.");
  await env.DB.prepare("INSERT INTO signalements(id,type,description,lat,lng,photo_id,contact,consentement_contact) VALUES(?,?,?,?,?,?,?,?)").bind(uid(),b.type,d,la,ln,ph,c,c?1:0).run();return J({ok:true})}
async function addVisite(env,b,team){const t=num(b.taille_cm,0,5000),cm=txt(b.commentaire,0,300),au=team?"équipe":txt(b.auteur,0,60),ph=await photoOk(env,b.photo_id),dt=team&&/^\d{4}-\d{2}-\d{2}$/.test(b.date_visite||"")&&b.date_visite<=day()?b.date_visite:day();
  if(!ETATS.includes(b.etat)||t===undefined||cm===undefined||au===undefined||ph===undefined)return bad("Visite invalide.");if(!await env.DB.prepare("SELECT 1 x FROM arbres WHERE id=?").bind(String(b.arbre_id||"")).first())return bad("Arbre introuvable.");
  await env.DB.prepare("INSERT INTO visites(id,arbre_id,date_visite,etat,taille_cm,commentaire,photo_id,auteur,valide) VALUES(?,?,?,?,?,?,?,?,?)").bind(uid(),b.arbre_id,dt,b.etat,t,cm,ph,au,team?1:0).run();return J({ok:true})}
async function addParrain(env,b){const n=txt(b.nom,2,100),c=txt(b.contact,6,120);if(!PARR.includes(b.type_parrain)||!n||!c)return bad("Parrainage invalide : indique ton nom et un contact.");
  if(!await env.DB.prepare("SELECT 1 x FROM arbres WHERE id=?").bind(String(b.arbre_id||"")).first())return bad("Arbre introuvable.");
  await env.DB.prepare("INSERT INTO parrainages(id,arbre_id,type_parrain,nom,contact,afficher_nom) VALUES(?,?,?,?,?,?)").bind(uid(),b.arbre_id,b.type_parrain,n,c,b.afficher_nom===true?1:0).run();return J({ok:true})}
async function addArbre(env,b){const e=txt(b.espece,2,60),la=+b.lat,ln=+b.lng,t=num(b.taille_cm,0,5000),r=txt(b.responsable,0,100),ph=await photoOk(env,b.photo_id),z=b.zone_id||null;
  if(!e||!/^\d{4}-\d{2}-\d{2}$/.test(b.date_plantation||"")||b.date_plantation>day()||!inBenin(la,ln)||t===undefined||r===undefined||ph===undefined||!ETATS.includes(b.etat||"vivant")||!EAU.includes(b.besoin_eau||"inconnu"))return bad("Arbre invalide : vérifie l'espèce, la date (pas dans le futur) et la position.");
  if(z&&!await env.DB.prepare("SELECT 1 x FROM zones WHERE id=?").bind(String(z)).first())return bad("Zone introuvable.");
  await env.DB.prepare("INSERT INTO arbres(id,espece,date_plantation,lat,lng,zone_id,etat,taille_cm,besoin_eau,responsable,photo_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(uid(),e,b.date_plantation,la,ln,z,b.etat||"vivant",t,b.besoin_eau||"inconnu",r,ph).run();return J({ok:true})}
export default{async fetch(req,env){const u=new URL(req.url);if(!u.pathname.startsWith("/api/"))return env.ASSETS?env.ASSETS.fetch(req):new Response("Introuvable",{status:404});try{return await route(req,env,u)}catch(e){return J({error:"Erreur du serveur : "+String(e&&e.message||e)},500)}}};
