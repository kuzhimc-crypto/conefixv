require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
// On Vercel, SITE_URL can be left blank and /api/status will use the request origin.
const CONFIGURED_SITE_URL = String(process.env.SITE_URL || '').trim().replace(/\/$/, '');
const IS_VERCEL = Boolean(process.env.VERCEL);
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
// Separate webhook for the client-side activity logger. Keeping it server-side means the
// webhook URL never ships to the browser, unlike the old approach where it was hardcoded
// directly in site.html for anyone to view-source and copy.
const LOG_WEBHOOK = process.env.DISCORD_LOG_WEBHOOK_URL || '';
const STATUS_INTERVAL_MS = Math.max(60000, Number(process.env.STATUS_INTERVAL_MS || 300000));
const AUTH_JWT_SECRET = String(process.env.AUTH_JWT_SECRET || '').trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/,'');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const AUTH_COOKIE = 'conefix_auth';
const AUTH_TTL_SECONDS = 60 * 60 * 24 * 7;
let statusMessageId = process.env.DISCORD_STATUS_MESSAGE_ID || '';
let startedAt = Date.now();
let lastStatus = null;

app.use(express.json());
// Allow the Site tab to live on Netlify or be opened locally while the creator API runs here.
app.use((req,res,next)=>{
  const origin = String(req.headers.origin || '');
  // Credentialed browser requests cannot use Access-Control-Allow-Origin: *.
  // Echo the requesting origin when present and explicitly allow cookies.
  if(origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const RUNTIME_DATA_DIR = IS_VERCEL ? '/tmp/conefix-data' : DATA_DIR;
const AUTH_DB = path.join(RUNTIME_DATA_DIR, 'auth-users.json');
const RUNTIME_UPLOAD_DIR = IS_VERCEL ? '/tmp/conefix-uploads' : UPLOAD_DIR;
const STATS_DB = path.join(RUNTIME_DATA_DIR, 'website-stats.json');
const CREATOR_DB = path.join(RUNTIME_DATA_DIR, 'creator-projects.json');
try { fs.mkdirSync(RUNTIME_DATA_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(RUNTIME_UPLOAD_DIR, { recursive: true }); } catch {}
app.use('/uploads', express.static(RUNTIME_UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));
const ACTIVE_TTL_MS = 5 * 60 * 1000;
const activeVisitors = new Map();
let memoryStats = defaultStats();
function todayKey(){ return new Date().toISOString().slice(0,10); }
function defaultStats(){ return { totalPageviews:0, totalDownloads:0, totalSessions:0, days:{} }; }
function readStats(){
  if (IS_VERCEL) return memoryStats;
  try { return JSON.parse(fs.readFileSync(STATS_DB,'utf8')); } catch { return defaultStats(); }
}
function writeStats(db){
  memoryStats = db;
  if (IS_VERCEL) return;
  try { fs.writeFileSync(STATS_DB, JSON.stringify(db,null,2)); } catch {}
}
function touchDay(db){ const k=todayKey(); if(!db.days[k]) db.days[k]={pageviews:0,uniqueVisitors:0,downloads:0}; return db.days[k]; }
function trackEvent(body){
  const db=readStats(), day=touchDay(db), event=String(body?.event||'pageview').toLowerCase();
  const session=String(body?.session||'').slice(0,120);
  if(event==='pageview' || event==='new visitor session') { db.totalPageviews++; day.pageviews++; }
  if(event.includes('download')) { db.totalDownloads++; day.downloads++; }
  if(session){
    const fresh=!activeVisitors.has(session);
    activeVisitors.set(session, Date.now());
    if(fresh){ db.totalSessions++; day.uniqueVisitors++; }
  }
  writeStats(db);
  return getStats(db);
}
function getStats(db=readStats()){
  const day=touchDay(db);
  const cutoff=Date.now()-ACTIVE_TTL_MS;
  for(const [id,seen] of activeVisitors) if(seen<cutoff) activeVisitors.delete(id);
  return { totalPageviews:db.totalPageviews||0, totalDownloads:db.totalDownloads||0, totalSessions:db.totalSessions||0, today:{pageviews:day.pageviews||0,uniqueVisitors:day.uniqueVisitors||0,downloads:day.downloads||0}, activeVisitors:activeVisitors.size, updatedAt:new Date().toISOString() };
}
if(!IS_VERCEL && !fs.existsSync(STATS_DB)) writeStats(defaultStats());


/* -------------------- CONEFIX AUTH --------------------
   Passwords are hashed with Node's built-in scrypt. On Vercel, persistent users
   are stored in Supabase via the service-role API; locally a JSON file is used.
   The service-role key never reaches the browser.
-------------------------------------------------------- */
function authConfigured() {
  return Boolean(AUTH_JWT_SECRET) && (Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) || !IS_VERCEL);
}
function authSetupError() {
  return 'Authentication is not configured. Add AUTH_JWT_SECRET, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel Environment Variables.';
}
if (!IS_VERCEL && !fs.existsSync(AUTH_DB)) {
  try { fs.writeFileSync(AUTH_DB, JSON.stringify({ users: [] }, null, 2)); } catch {}
}
let memoryAuthDB = { users: [] };
function readAuthDB() {
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) return null;
  if (IS_VERCEL) return memoryAuthDB;
  try { return JSON.parse(fs.readFileSync(AUTH_DB, 'utf8')); } catch { return { users: [] }; }
}
function writeAuthDB(db) {
  memoryAuthDB = db;
  if (IS_VERCEL || !db) return;
  try { fs.writeFileSync(AUTH_DB, JSON.stringify(db, null, 2)); } catch {}
}
function cleanUsername(v) { return String(v || '').trim().replace(/\s+/g,' ').slice(0,32); }
function cleanEmail(v) { return String(v || '').trim().toLowerCase().slice(0,254); }
function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function validUsername(v) { return /^[a-zA-Z0-9_.-]{3,32}$/.test(v); }
function hashPassword(password) {
  return new Promise((resolve,reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err,key) => {
      if (err) return reject(err);
      resolve(`scrypt$16384$8$1$${salt}$${key.toString('hex')}`);
    });
  });
}
function verifyPassword(password, stored) {
  return new Promise(resolve => {
    const parts=String(stored||'').split('$');
    if(parts.length!==7 || parts[0]!=='scrypt') return resolve(false);
    const N=Number(parts[1]), r=Number(parts[2]), p=Number(parts[3]), salt=parts[4], expected=Buffer.from(parts[5]||'', 'hex');
    if(!N || !r || !p || !salt || expected.length!==64) return resolve(false);
    crypto.scrypt(password, salt, 64, {N,r,p}, (err,key) => {
      if(err || key.length!==expected.length) return resolve(false);
      resolve(crypto.timingSafeEqual(key, expected));
    });
  });
}
function base64url(input){ return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function signToken(payload) {
  const header=base64url(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const body=base64url(JSON.stringify(payload));
  const sig=crypto.createHmac('sha256',AUTH_JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
function verifyToken(token) {
  try {
    if(!AUTH_JWT_SECRET || !token) return null;
    const [header,body,sig]=String(token).split('.');
    if(!header||!body||!sig) return null;
    const expected=crypto.createHmac('sha256',AUTH_JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    const a=Buffer.from(sig), b=Buffer.from(expected);
    if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return null;
    const p=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(!p.exp || p.exp < Math.floor(Date.now()/1000)) return null;
    return p;
  } catch { return null; }
}
function getCookie(req,name){
  const raw=String(req.headers.cookie||'');
  const item=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));
  return item ? decodeURIComponent(item.slice(name.length+1)) : '';
}
function currentUser(req){ return verifyToken(getCookie(req,AUTH_COOKIE)); }
function requireAuth(req,res,next){
  const user=currentUser(req);
  if(!user) return res.status(401).json({error:'Please log in to continue.'});
  req.user=user; next();
}
function authUserView(u){ return u ? {id:u.id,username:u.username,email:u.email,createdAt:u.created_at||u.createdAt} : null; }
async function supabaseRequest(endpoint, options={}) {
  if(!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error(authSetupError());
  const res=await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`,{
    ...options,
    headers:{
      apikey:SUPABASE_SERVICE_ROLE_KEY,
      Authorization:`Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':'application/json',
      ...(options.headers||{})
    }
  });
  const text=await res.text();
  let data=null; try{data=text?JSON.parse(text):null;}catch{}
  if(!res.ok) throw new Error(data?.message || data?.hint || `Database HTTP ${res.status}`);
  return data;
}
async function findUserByUsername(username){
  if(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY){
    const rows=await supabaseRequest(`conefix_users?select=id,username,email,password_hash,created_at&username=eq.${encodeURIComponent(username)}&limit=1`);
    return rows?.[0]||null;
  }
  const db=readAuthDB(); return db.users.find(u=>u.username.toLowerCase()===username.toLowerCase())||null;
}
async function findUserByEmail(email){
  if(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY){
    const rows=await supabaseRequest(`conefix_users?select=id,username,email,password_hash,created_at&email=eq.${encodeURIComponent(email)}&limit=1`);
    return rows?.[0]||null;
  }
  const db=readAuthDB(); return db.users.find(u=>u.email.toLowerCase()===email.toLowerCase())||null;
}
async function createUser(user){
  if(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY){
    const rows=await supabaseRequest('conefix_users?select=id,username,email,created_at',{
      method:'POST', headers:{Prefer:'return=representation'}, body:JSON.stringify(user)
    });
    return rows?.[0]||null;
  }
  const db=readAuthDB();
  const local={id:safeId(),...user,created_at:new Date().toISOString()};
  db.users.push(local); writeAuthDB(db); return local;
}
function setAuthCookie(res,token){
  const secure=IS_VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie',`${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${AUTH_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`);
}
function clearAuthCookie(res){
  const secure=IS_VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie',`${AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
}
function authTokenFor(user){
  const now=Math.floor(Date.now()/1000);
  return signToken({sub:user.id,username:user.username,email:user.email,iat:now,exp:now+AUTH_TTL_SECONDS});
}

app.get('/api/auth/config', (_req,res)=>res.json({configured:authConfigured()}));
app.get('/api/auth/me', (req,res)=>{
  const user=currentUser(req);
  res.json({authenticated:Boolean(user),user:authUserView(user)});
});
app.post('/api/auth/signup', async (req,res)=>{
  try{
    if(!authConfigured()) return res.status(503).json({error:authSetupError()});
    const username=cleanUsername(req.body?.username), email=cleanEmail(req.body?.email), password=String(req.body?.password||'');
    if(!validUsername(username)) return res.status(400).json({error:'Username must be 3–32 characters: letters, numbers, _, . or -.'});
    if(!validEmail(email)) return res.status(400).json({error:'Enter a valid email address.'});
    if(password.length<8 || password.length>128) return res.status(400).json({error:'Password must be 8–128 characters.'});
    if(await findUserByUsername(username) || await findUserByEmail(email)) return res.status(409).json({error:'That username or email is already registered.'});
    const password_hash=await hashPassword(password);
    const user=await createUser({username,email,password_hash});
    if(!user) throw new Error('Could not create account.');
    setAuthCookie(res,authTokenFor(user));
    res.status(201).json({ok:true,user:authUserView(user)});
  }catch(e){res.status(500).json({error:e.message||'Could not create account.'});}
});
app.post('/api/auth/login', async (req,res)=>{
  try{
    if(!authConfigured()) return res.status(503).json({error:authSetupError()});
    const identifier=String(req.body?.identifier||'').trim(), password=String(req.body?.password||'');
    if(!identifier || !password) return res.status(400).json({error:'Enter your username/email and password.'});
    const user=identifier.includes('@') ? await findUserByEmail(cleanEmail(identifier)) : await findUserByUsername(cleanUsername(identifier));
    if(!user || !(await verifyPassword(password,user.password_hash))) return res.status(401).json({error:'Incorrect login details.'});
    setAuthCookie(res,authTokenFor(user));
    res.json({ok:true,user:authUserView(user)});
  }catch(e){res.status(500).json({error:e.message||'Could not log in.'});}
});
app.post('/api/auth/logout', (req,res)=>{ clearAuthCookie(res); res.json({ok:true}); });

if (!IS_VERCEL && !fs.existsSync(CREATOR_DB)) { try { fs.writeFileSync(CREATOR_DB, JSON.stringify({ projects: [] }, null, 2)); } catch {} }
let memoryCreatorDB = { projects: [] };
function readCreatorDB(){ if (IS_VERCEL) return memoryCreatorDB; try { return JSON.parse(fs.readFileSync(CREATOR_DB, 'utf8')); } catch { return { projects: [] }; } }
function writeCreatorDB(db){ memoryCreatorDB = db; if (IS_VERCEL) return; try { fs.writeFileSync(CREATOR_DB, JSON.stringify(db, null, 2)); } catch {} }
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, RUNTIME_UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,10)}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`)
});
const upload = multer({ storage, limits: { fileSize: IS_VERCEL ? 4 * 1024 * 1024 : 250 * 1024 * 1024, files: 12 } });
function cleanList(v){ return String(v||'').split(',').map(x=>x.trim()).filter(Boolean); }
function safeId(){ return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`; }

app.get('/api/creator/health', (_req,res)=>res.json({ok:true,service:'CONEFIX Creator API'}));
app.get('/api/creator/projects', (_req, res) => res.json(readCreatorDB()));
app.get('/api/creator/my-projects', requireAuth, (req, res) => {
  const db=readCreatorDB();
  res.json({projects:db.projects.filter(p=>p.ownerId===req.user.sub)});
});
app.post('/api/creator/projects', requireAuth, upload.fields([{name:'icon',maxCount:1},{name:'screenshots',maxCount:8}]), (req,res)=>{
  try{
    const db=readCreatorDB();
    const id=safeId();
    const files=req.files||{};
    const icon=files.icon?.[0] ? `/uploads/${files.icon[0].filename}` : '';
    const screenshots=(files.screenshots||[]).map(f=>`/uploads/${f.filename}`);
    const project={id,ownerId:req.user.sub,ownerUsername:req.user.username,name:String(req.body.name||'').trim(),description:String(req.body.description||'').trim(),category:String(req.body.category||'').trim(),license:String(req.body.license||'').trim(),minecraft_versions:cleanList(req.body.minecraft_versions),loaders:cleanList(req.body.loaders),links:String(req.body.links||'').trim(),icon,screenshots,downloads:0,followers:0,createdAt:new Date().toISOString(),versions:[]};
    if(!project.name||!project.description||!project.category) return res.status(400).json({error:'Project name, description and category are required.'});
    db.projects.push(project);writeCreatorDB(db);res.status(201).json(project);
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/creator/projects/:id/versions', requireAuth, upload.single('file'), (req,res)=>{
  try{
    const db=readCreatorDB();const p=db.projects.find(x=>x.id===req.params.id && x.ownerId===req.user.sub);if(!p)return res.status(404).json({error:'Project not found.'});
    if(!req.file)return res.status(400).json({error:'Version file is required.'});
    const version={id:safeId(),version:String(req.body.version||'').trim(),minecraft_version:String(req.body.minecraft_version||'').trim(),loader:String(req.body.loader||'').trim(),filename:req.file.originalname,file:`/uploads/${req.file.filename}`,size:req.file.size,changelog:String(req.body.changelog||'').trim(),dependencies:String(req.body.dependencies||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean),uploadedAt:new Date().toISOString(),downloads:0};
    if(!version.version||!version.minecraft_version)return res.status(400).json({error:'Version and Minecraft version are required.'});
    p.versions.unshift(version);writeCreatorDB(db);res.status(201).json(version);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/creator/projects/:id', (req,res)=>{const p=readCreatorDB().projects.find(x=>x.id===req.params.id);p?res.json(p):res.status(404).json({error:'Project not found.'});});


function requestSiteUrl(req) {
  if (CONFIGURED_SITE_URL) return CONFIGURED_SITE_URL;
  const proto = req?.headers?.['x-forwarded-proto']?.split(',')[0].trim() || req?.protocol || 'https';
  const host = req?.headers?.host;
  return host ? `${proto}://${host}` : 'http://localhost:3000';
}

async function checkWebsite(siteUrl) {
  const started = Date.now();
  try {
    const res = await fetch(siteUrl, { redirect: 'follow' });
    const ms = Date.now() - started;
    return { online: res.ok, code: res.status, responseMs: ms };
  } catch (error) {
    return { online: false, code: 0, responseMs: Date.now() - started, error: error.message };
  }
}

function uptimeText() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

async function discordRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// Tiny in-memory rate limiter for the public /api/log proxy so one visitor can't flood
// the Discord channel with requests. Not meant to be a general-purpose limiter — just
// enough to blunt accidental loops or casual abuse.
const logHits = new Map();
const LOG_LIMIT = 30;      // requests
const LOG_WINDOW_MS = 60000; // per minute, per IP
function isRateLimited(ip) {
  const now = Date.now();
  const entry = logHits.get(ip);
  if (!entry || now > entry.resetAt) {
    logHits.set(ip, { count: 1, resetAt: now + LOG_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > LOG_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of logHits) if (now > entry.resetAt) logHits.delete(ip);
}, LOG_WINDOW_MS).unref?.();

function buildEmbed(check, stats) {
  const online = check.online;
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  return {
    username: 'CONEFIX • Web Monitor',
    embeds: [{
      title: '🌐 CONEFIX WEB STATUS',
      description: 'Official CONEFIX website hosting status',
      color: online ? 0x9a45ff : 0xff315b,
      fields: [
        { name: 'STATUS', value: online ? '```diff\n+ ONLINE\n```' : '```diff\n- OFFLINE\n```', inline: true },
        { name: 'WEBSITE', value: online ? '🟢 OPERATIONAL' : '🔴 UNAVAILABLE', inline: true },
        { name: 'RESPONSE TIME', value: `${check.responseMs} ms`, inline: true },
        { name: 'HTTP', value: check.code ? String(check.code) : 'No response', inline: true },
        { name: 'UPTIME', value: uptimeText(), inline: true },
        { name: 'LAST UPDATE', value: `${now} IST`, inline: true },
        { name: 'LIVE VISITORS', value: String(stats.activeVisitors), inline: true },
        { name: 'TODAY', value: `${stats.today.uniqueVisitors} visitors`, inline: true },
        { name: 'PAGE VIEWS', value: String(stats.today.pageviews), inline: true },
        { name: 'DOWNLOADS', value: String(stats.today.downloads), inline: true },
        { name: 'ALL-TIME VIEWS', value: String(stats.totalPageviews), inline: true },
        { name: 'ALL-TIME DOWNLOADS', value: String(stats.totalDownloads), inline: true }
      ],
      footer: { text: 'CONEFIX Web Monitor • automatic status' },
      timestamp: new Date().toISOString()
    }],
    allowed_mentions: { parse: [] }
  };
}

async function publishStatus(siteUrl = CONFIGURED_SITE_URL || 'http://localhost:3000') {
  const check = await checkWebsite(siteUrl);
  const stats = getStats();
  lastStatus = { ...check, checkedAt: new Date().toISOString(), stats };
  if (!WEBHOOK) return lastStatus;
  const payload = buildEmbed(check, stats);
  if (statusMessageId) {
    await discordRequest(`${WEBHOOK}/messages/${statusMessageId}`, { method: 'PATCH', body: JSON.stringify(payload) });
  } else {
    const data = await discordRequest(`${WEBHOOK}?wait=true`, { method: 'POST', body: JSON.stringify(payload) });
    statusMessageId = data?.id || '';
  }
  return lastStatus;
}

app.post('/api/track', (req,res)=>{
  try { res.json(trackEvent(req.body||{})); } catch(e) { res.status(500).json({error:'Could not record stats.'}); }
});
app.get('/api/stats', (_req,res)=>res.json(getStats()));

app.get('/api/status', async (req, res) => {
  try {
    const result = await publishStatus(requestSiteUrl(req));
    res.json({ ...result, uptime: uptimeText(), site: requestSiteUrl(req) });
  } catch (error) {
    res.status(502).json({ online: false, error: error.message, site: requestSiteUrl(req) });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'CONEFIX Web Monitor' }));

// Proxies the site's client-side activity logger to Discord. The webhook URL stays in
// this server's environment only; the browser only ever talks to this same-origin route.
app.post('/api/log', async (req, res) => {
  if (!LOG_WEBHOOK) return res.status(204).end();
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many log requests.' });
  try {
    const embeds = Array.isArray(req.body?.embeds) ? req.body.embeds.slice(0, 10) : [];
    if (!embeds.length) return res.status(400).json({ error: 'No embeds provided.' });
    await discordRequest(`${LOG_WEBHOOK}?wait=false`, {
      method: 'POST',
      body: JSON.stringify({ username: 'CONEFIX • Web Monitor', allowed_mentions: { parse: [] }, embeds })
    });
    res.status(204).end();
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Vercel runs the exported Express app as a managed function.
// Local development still uses the normal Node server.
if (!IS_VERCEL) {
  app.listen(PORT, async () => {
    console.log(`CONEFIX backend running on http://localhost:${PORT}`);
    try { await publishStatus(CONFIGURED_SITE_URL || `http://localhost:${PORT}`); } catch (e) { console.error('Initial Discord update failed:', e.message); }
    setInterval(() => publishStatus(CONFIGURED_SITE_URL || `http://localhost:${PORT}`).catch(e => console.error('Status update failed:', e.message)), STATUS_INTERVAL_MS);
  });
}

module.exports = app;
