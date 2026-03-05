require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
const fs = require('fs');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const PORT = process.env.PORT || 3000;

const DATA_DIR    = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const db = low(new FileSync(path.join(DATA_DIR, 'db.json')));
db.defaults({
  folders:   {},
  files:     {},
  trash:     {},
  users:     {},
  purchases: {},
  activity:  [],
  online:    {}
}).write();

const ADMIN_PASSWORD       = process.env.ADMIN_PASSWORD       || 'changeme123';
const ADMIN_EMAILS         = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const SESSION_SECRET       = process.env.SESSION_SECRET       || 'vault-dev-secret';
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL             = process.env.BASE_URL             || `http://localhost:${PORT}`;
const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID        || '';
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID     || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET_NAME       = process.env.R2_BUCKET_NAME       || '';
const USE_R2               = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME);

let s3Client = null;
if (USE_R2) {
  s3Client = new S3Client({ region: 'auto', endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY } });
  console.log('R2 enabled');
}

let upload;
if (USE_R2) {
  upload = multer({ storage: multerS3({ s3: s3Client, bucket: R2_BUCKET_NAME, key: (req, file, cb) => { const ext = path.extname(file.originalname); cb(null, `uploads/${uuidv4()}${ext}`); } }), limits: { fileSize: 2*1024*1024*1024 } });
} else {
  upload = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, UPLOADS_DIR), filename: (req, file, cb) => { const ext = path.extname(file.originalname); cb(null, uuidv4() + ext); } }), limits: { fileSize: 2*1024*1024*1024 } });
}

app.use(cors()); app.use(express.json()); app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { secure: false, maxAge: 7*24*60*60*1000 } }));
app.use(passport.initialize()); app.use(passport.session());

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({ clientID: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, callbackURL: `${BASE_URL}/auth/google/callback` }, (at, rt, profile, done) => {
    const email = profile.emails[0].value.toLowerCase();
    const user = { id: profile.id, uid: profile.id, email, name: profile.displayName, avatar: profile.photos[0]?.value || '' };
    const now = new Date().toISOString(); const existing = db.get(`users.${email}`).value() || {};
    db.set(`users.${email}`, { ...user, firstSeen: existing.firstSeen || now, lastSeen: now, totalUploads: existing.totalUploads || 0, totalDownloads: existing.totalDownloads || 0, storageUsed: existing.storageUsed || 0 }).write();
    return done(null, user);
  }));
}
passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((u, d) => d(null, u));

const isAdmin = req => !!(req.session?.adminAuth || (req.user && ADMIN_EMAILS.includes(req.user.email)));
const requireAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Admin required' });
const requireUser  = (req, res, next) => req.user  ? next() : res.status(401).json({ error: 'Sign in required' });

function logActivity(type, who, what, detail='', size=0) {
  const log = db.get('activity').value();
  log.unshift({ id: uuidv4(), type, who, what, when: new Date().toISOString(), detail, size });
  if (log.length > 1000) log.splice(1000);
  db.set('activity', log).write();
  io.to('admins').emit('activity', { type, who, what, detail, when: new Date().toISOString() });
}

function canAccessFolder(folderId, userEmail, admin) {
  if (admin) return true;
  const f = db.get(`folders.${folderId}`).value();
  return f && (f.allowedEmails || []).includes(userEmail);
}

function hasPurchased(fileId, userEmail) {
  return Object.values(db.get('purchases').value() || {}).some(p => p.fileId === fileId && p.userEmail === userEmail);
}

function canAccessFile(fileId, userEmail, admin) {
  if (admin) return true;
  const f = db.get(`files.${fileId}`).value();
  if (!f) return false;
  if (f.price && f.price > 0) return hasPurchased(fileId, userEmail);
  if ((f.allowedEmails || []).includes(userEmail)) return true;
  if ((f.allowedEmails || []).length === 0 && !f.folderId) return true;
  if (f.folderId) return canAccessFolder(f.folderId, userEmail, false);
  return false;
}

async function getDownloadUrl(file) {
  if (USE_R2 && file.key) {
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: file.key });
    return getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
  }
  return `${BASE_URL}/download/${file.id}`;
}

const onlineUsers = new Map();
io.on('connection', (socket) => {
  socket.on('auth', ({ email, name, isAdmin: admin }) => {
    if (!email) return;
    onlineUsers.set(socket.id, { email, name });
    if (admin) socket.join('admins');
    db.set(`online.${email}`, new Date().toISOString()).write();
    io.to('admins').emit('presence', { email, name, online: true });
  });
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) { onlineUsers.delete(socket.id); io.to('admins').emit('presence', { email: user.email, name: user.name, online: false }); }
  });
  socket.on('join-folder', fid => socket.join(`folder:${fid}`));
  socket.on('leave-folder', fid => socket.leave(`folder:${fid}`));
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }), (req, res) => { const r = req.session.returnTo || '/'; delete req.session.returnTo; res.redirect(r); });
app.post('/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.post('/auth/admin-password', (req, res) => { if (req.body.password === ADMIN_PASSWORD) { req.session.adminAuth = true; res.json({ success: true }); } else res.status(401).json({ error: 'Wrong password' }); });
app.get('/api/me', (req, res) => res.json({ user: req.user || null, isAdmin: isAdmin(req) }));

app.post('/api/folders', requireAdmin, (req, res) => {
  const { name, parentId=null } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  const folder = { id, name: name.trim(), parentId, allowedEmails: [], createdAt: new Date().toISOString(), createdBy: req.user?.email || 'admin' };
  db.set(`folders.${id}`, folder).write();
  logActivity('folder_create', req.user?.email || 'admin', name.trim(), 'Folder created');
  io.emit('folder:created', folder); res.json(folder);
});

app.get('/api/folders', requireUser, (req, res) => {
  const admin = isAdmin(req); const email = req.user.email;
  const all = Object.values(db.get('folders').value() || {});
  res.json(admin ? all : all.filter(f => canAccessFolder(f.id, email, false)));
});

app.put('/api/folders/:id', requireAdmin, (req, res) => {
  const folder = db.get(`folders.${req.params.id}`).value();
  if (!folder) return res.status(404).json({ error: 'Not found' });
  const updates = {};
  if (req.body.name) updates.name = req.body.name.trim();
  if (req.body.allowedEmails !== undefined) updates.allowedEmails = req.body.allowedEmails.map(e => e.trim().toLowerCase()).filter(e => e.includes('@'));
  const updated = { ...folder, ...updates };
  db.set(`folders.${req.params.id}`, updated).write();
  logActivity('folder_update', req.user?.email || 'admin', folder.name, 'Updated');
  io.emit('folder:updated', updated); res.json(updated);
});

app.delete('/api/folders/:id', requireAdmin, (req, res) => {
  const folder = db.get(`folders.${req.params.id}`).value();
  if (!folder) return res.status(404).json({ error: 'Not found' });
  db.set(`trash.${folder.id}`, { ...folder, type: 'folder', trashedAt: new Date().toISOString(), trashedBy: req.user?.email || 'admin' }).write();
  db.unset(`folders.${folder.id}`).write();
  logActivity('folder_trash', req.user?.email || 'admin', folder.name, 'Moved to trash');
  io.emit('folder:deleted', { id: folder.id }); res.json({ success: true });
});

app.post('/api/files', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const folderId = req.body.folderId || null;
  const price = parseFloat(req.body.price) || 0;
  const id = uuidv4(); const isR2 = USE_R2 && req.file.key;
  const fileEntry = {
    id, name: req.file.originalname.replace(/[^a-zA-Z0-9._\-\s]/g, '_'),
    key: isR2 ? req.file.key : null, diskName: isR2 ? null : req.file.filename,
    url: isR2 ? req.file.location : null, storage: isR2 ? 'r2' : 'local',
    folderId, size: req.file.size, mimetype: req.file.mimetype,
    uploadedAt: new Date().toISOString(), uploadedBy: req.user?.email || 'admin',
    allowedEmails: [], price, isFree: price === 0
  };
  db.set(`files.${id}`, fileEntry).write();
  const uploader = req.user?.email;
  if (uploader) { const u = db.get(`users.${uploader}`).value() || {}; db.set(`users.${uploader}.totalUploads`, (u.totalUploads||0)+1).write(); db.set(`users.${uploader}.storageUsed`, (u.storageUsed||0)+req.file.size).write(); }
  logActivity('upload', req.user?.email || 'admin', fileEntry.name, `Price: ${price===0?'FREE':'$'+price}`, req.file.size);
  io.to(folderId ? `folder:${folderId}` : 'folder:root').emit('file:created', fileEntry);
  if (folderId) io.to('folder:root').emit('file:created', fileEntry);
  res.json(fileEntry);
});

app.get('/api/files', requireUser, (req, res) => {
  const admin = isAdmin(req); const email = req.user.email;
  const folderId = req.query.folderId || null;
  const all = Object.values(db.get('files').value() || {}).filter(f => f.folderId === folderId);
  const result = all.map(f => {
    const purchased = hasPurchased(f.id, email);
    return { ...f, locked: !admin && !canAccessFile(f.id, email, false), purchased, ...(admin ? {} : { key: undefined, diskName: undefined }) };
  });
  res.json(result.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)));
});

app.get('/api/files/:id', requireUser, (req, res) => {
  const file = db.get(`files.${req.params.id}`).value();
  if (!file) return res.status(404).json({ error: 'Not found' });
  const admin = isAdmin(req); const email = req.user.email;
  res.json({ ...file, locked: !admin && !canAccessFile(file.id, email, false), purchased: hasPurchased(file.id, email), ...(admin ? {} : { key: undefined, diskName: undefined }) });
});

app.patch('/api/files/:id', requireAdmin, (req, res) => {
  const file = db.get(`files.${req.params.id}`).value();
  if (!file) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined) db.set(`files.${req.params.id}.name`, req.body.name.trim()).write();
  if (req.body.folderId !== undefined) db.set(`files.${req.params.id}.folderId`, req.body.folderId).write();
  if (req.body.price !== undefined) { const price = parseFloat(req.body.price)||0; db.set(`files.${req.params.id}.price`, price).write(); db.set(`files.${req.params.id}.isFree`, price===0).write(); }
  const updated = db.get(`files.${req.params.id}`).value();
  logActivity('rename', req.user?.email || 'admin', file.name, req.body.name ? `Renamed to ${req.body.name}` : 'Updated');
  io.emit('file:updated', updated); res.json(updated);
});

app.put('/api/files/:id/permissions', requireAdmin, (req, res) => {
  const file = db.get(`files.${req.params.id}`).value();
  if (!file) return res.status(404).json({ error: 'Not found' });
  const emails = (req.body.emails || []).map(e => e.trim().toLowerCase()).filter(e => e.includes('@'));
  db.set(`files.${req.params.id}.allowedEmails`, emails).write();
  io.emit('file:updated', { ...file, allowedEmails: emails });
  res.json({ success: true, allowedEmails: emails });
});

app.post('/api/files/:id/buy', requireUser, (req, res) => {
  const file = db.get(`files.${req.params.id}`).value();
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (file.isFree || !file.price) return res.status(400).json({ error: 'This file is free' });
  const email = req.user.email; const name = req.user.name;
  if (hasPurchased(file.id, email)) return res.status(400).json({ error: 'Already purchased' });
  const purchaseId = uuidv4();
  const purchase = { id: purchaseId, userEmail: email, userName: name, fileId: file.id, fileName: file.name, fileSize: file.size, price: file.price, purchasedAt: new Date().toISOString(), downloadCount: 0 };
  db.set(`purchases.${purchaseId}`, purchase).write();
  logActivity('purchase', email, file.name, `Purchased for $${file.price}`, file.size);
  io.to('admins').emit('purchase', purchase);
  res.json({ success: true, purchase });
});

app.get('/api/my-purchases', requireUser, (req, res) => {
  const email = req.user.email;
  const purchases = Object.values(db.get('purchases').value() || {})
    .filter(p => p.userEmail === email)
    .sort((a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt))
    .map(p => ({ ...p, file: db.get(`files.${p.fileId}`).value() || null }));
  res.json(purchases);
});

app.get('/api/purchases', requireAdmin, (req, res) => {
  const purchases = Object.values(db.get('purchases').value() || {})
    .sort((a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt))
    .map(p => ({ ...p, file: db.get(`files.${p.fileId}`).value() || null, user: db.get(`users.${p.userEmail}`).value() || null }));
  res.json(purchases);
});

app.delete('/api/purchases/:id', requireAdmin, (req, res) => {
  const purchase = db.get(`purchases.${req.params.id}`).value();
  if (!purchase) return res.status(404).json({ error: 'Not found' });
  db.unset(`purchases.${req.params.id}`).write();
  logActivity('purchase_revoke', req.user?.email || 'admin', purchase.fileName, `Revoked from ${purchase.userEmail}`);
  res.json({ success: true });
});

app.get('/preview/:id', requireUser, async (req, res) => {
  const file = db.get(`files.${req.params.id}`).value();
  if (!file) return res.status(404).send('Not found');
  const isImage = file.mimetype && file.mimetype.startsWith('image/');
  if (!isImage) return res.status(400).send('Not an image');
  const admin = isAdmin(req); const email = req.user.email;
  if (!admin && !canAccessFile(file.id, email, false) && !(file.isFree)) return res.status(403).send('Access denied');
  if (USE_R2 && file.key) return res.redirect(await getDownloadUrl(file));
  const fp = path.join(UPLOADS_DIR, file.diskName);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing');
  res.set('Content-Type', file.mimetype);
  fs.createReadStream(fp).pipe(res);
});

app.get('/download/:id', requireUser, async (req, res) => {
  const file = db.get(`files.${req.params.id}`).value();
  if (!file) return res.status(404).send('Not found');
  const admin = isAdmin(req); const email = req.user.email;
  if (!canAccessFile(file.id, email, admin)) return res.status(403).json({ error: 'Access denied. Purchase this file to download.' });
  const u = db.get(`users.${email}`).value() || {};
  db.set(`users.${email}.totalDownloads`, (u.totalDownloads||0)+1).write();
  const purchase = Object.values(db.get('purchases').value() || {}).find(p => p.fileId === file.id && p.userEmail === email);
  if (purchase) db.set(`purchases.${purchase.id}.downloadCount`, (purchase.downloadCount||0)+1).write();
  logActivity('download', email, file.name, 'Downloaded', file.size);
  if (USE_R2 && file.key) return res.redirect(await getDownloadUrl(file));
  const fp = path.join(UPLOADS_DIR, file.diskName);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing');
  res.download(fp, file.name);
});

app.get('/api/trash', requireAdmin, (req, res) => res.json(Object.values(db.get('trash').value() || {}).sort((a, b) => new Date(b.trashedAt) - new Date(a.trashedAt))));

app.post('/api/trash/:id/restore', requireAdmin, (req, res) => {
  const item = db.get(`trash.${req.params.id}`).value();
  if (!item) return res.status(404).json({ error: 'Not in trash' });
  const { type, trashedAt, trashedBy, ...original } = item;
  if (type === 'file') db.set(`files.${item.id}`, original).write();
  else db.set(`folders.${item.id}`, original).write();
  db.unset(`trash.${item.id}`).write();
  logActivity('restore', req.user?.email || 'admin', item.name, 'Restored');
  res.json({ success: true });
});

app.delete('/api/trash/:id', requireAdmin, async (req, res) => {
  const item = db.get(`trash.${req.params.id}`).value();
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (USE_R2 && item.key && s3Client) { try { await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: item.key })); } catch(e) {} }
  else if (item.diskName) { const fp = path.join(UPLOADS_DIR, item.diskName); if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch(e) {} }
  db.unset(`trash.${item.id}`).write();
  logActivity('delete', req.user?.email || 'admin', item.name, 'Permanently deleted');
  res.json({ success: true });
});

app.delete('/api/trash', requireAdmin, async (req, res) => {
  const items = Object.values(db.get('trash').value() || {});
  for (const item of items) {
    if (USE_R2 && item.key && s3Client) { try { await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: item.key })); } catch(e) {} }
    else if (item.diskName) { const fp = path.join(UPLOADS_DIR, item.diskName); if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch(e) {} }
  }
  db.set('trash', {}).write();
  logActivity('empty_trash', req.user?.email || 'admin', 'Trash', `Emptied (${items.length} items)`);
  res.json({ success: true });
});

app.get('/api/users', requireAdmin, (req, res) => {
  const users = Object.values(db.get('users').value() || {});
  const onlineEmails = new Set([...onlineUsers.values()].map(u => u.email));
  const purchases = Object.values(db.get('purchases').value() || {});
  res.json(users.map(u => ({ ...u, online: onlineEmails.has(u.email), totalPurchases: purchases.filter(p => p.userEmail === u.email).length, totalSpent: purchases.filter(p => p.userEmail === u.email).reduce((s, p) => s + (p.price||0), 0) })).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)));
});

app.get('/api/activity', requireAdmin, (req, res) => res.json(db.get('activity').value().slice(0, parseInt(req.query.limit) || 100)));

app.get('/api/analytics', requireAdmin, (req, res) => {
  const files = Object.values(db.get('files').value() || {});
  const folders = Object.values(db.get('folders').value() || {});
  const users = Object.values(db.get('users').value() || {});
  const trash = Object.values(db.get('trash').value() || {});
  const activity = db.get('activity').value();
  const purchases = Object.values(db.get('purchases').value() || {});
  const totalStorage = files.reduce((s, f) => s + (f.size||0), 0);
  const totalRevenue = purchases.reduce((s, p) => s + (p.price||0), 0);
  const now = Date.now();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now - i * 86400000);
    const label = d.toLocaleDateString('en-US', { weekday: 'short' });
    const dateStr = d.toISOString().slice(0, 10);
    const dayA = activity.filter(a => a.when.startsWith(dateStr));
    const dayP = purchases.filter(p => p.purchasedAt.startsWith(dateStr));
    return { label, uploads: dayA.filter(a => a.type==='upload').length, downloads: dayA.filter(a => a.type==='download').length, purchases: dayP.length, revenue: dayP.reduce((s, p) => s+(p.price||0), 0) };
  }).reverse();
  const typeMap = {};
  files.forEach(f => { const ext = (f.name.split('.').pop()||'other').toLowerCase(); typeMap[ext] = (typeMap[ext]||0)+1; });
  const fileTypes = Object.entries(typeMap).sort((a,b) => b[1]-a[1]).slice(0,6).map(([ext, count]) => ({ ext, count }));
  const topUploaders = users.sort((a,b) => (b.totalUploads||0)-(a.totalUploads||0)).slice(0,5).map(u => ({ email: u.email, name: u.name, uploads: u.totalUploads||0, storage: u.storageUsed||0 }));
  res.json({
    totals: { files: files.length, folders: folders.length, users: users.length, trash: trash.length, totalStorage, downloads: activity.filter(a=>a.type==='download').length, uploads: activity.filter(a=>a.type==='upload').length, onlineCount: onlineUsers.size, totalRevenue, purchases: purchases.length, paidFiles: files.filter(f=>f.price>0).length, freeFiles: files.filter(f=>!f.price||f.price===0).length },
    days, topUploaders, fileTypes, storage: { used: totalStorage, provider: USE_R2 ? 'Cloudflare R2' : 'Local Disk' }
  });
});

app.get('/api/stats', requireAdmin, (req, res) => {
  const files = Object.values(db.get('files').value() || {});
  const users = Object.values(db.get('users').value() || {});
  res.json({ files: files.length, totalStorage: files.reduce((s,f) => s+(f.size||0), 0), users: users.length, storageProvider: USE_R2 ? 'r2' : 'local' });
});

app.get('/ping', (req, res) => res.json({ status: 'ok', ts: Date.now() }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

httpServer.listen(PORT, () => {
  console.log(`\n🔐 Vault v5 — Buy Files Edition`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`   Storage: ${USE_R2 ? 'Cloudflare R2' : 'Local disk'}`);
  console.log(`   Admins: ${ADMIN_EMAILS.join(', ') || '(password only)'}\n`);
});
