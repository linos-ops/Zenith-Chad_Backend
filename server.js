require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const webpush = require('web-push');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { checkUsername } = require('./username');

// ---------- SETUP CHECK ----------
if (!process.env.MONGO_URI || !/^[0-9a-f]{64}$/i.test(process.env.ID_KEY || '')) {
    console.error('Missing MONGO_URI or ID_KEY (64 hex characters). See .env.example');
    process.exit(1);
}
const ID_KEY = Buffer.from(process.env.ID_KEY, 'hex');
const ADMIN_OK = (process.env.ADMIN_SECRET || '').length >= 20;
if (!ADMIN_OK) console.warn('ADMIN_SECRET missing or under 20 characters: admin panel is OFF.');

// ---------- HELPERS ----------
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');
const same = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
// Identity data (IP, device info) is stored encrypted. Old plain-text records still read fine.
const enc = t => { const iv = crypto.randomBytes(12), k = crypto.createCipheriv('aes-256-gcm', ID_KEY, iv);
    const d = Buffer.concat([k.update(String(t == null ? '' : t), 'utf8'), k.final()]);
    return [iv, k.getAuthTag(), d].map(b => b.toString('hex')).join('.'); };
const dec = s => { try { const p = String(s || '').split('.');
    if (p.length !== 3 || !p.every(x => /^[0-9a-f]+$/i.test(x))) return s || '';
    const [iv, tag, d] = p.map(h => Buffer.from(h, 'hex')), k = crypto.createDecipheriv('aes-256-gcm', ID_KEY, iv);
    k.setAuthTag(tag); return Buffer.concat([k.update(d), k.final()]).toString('utf8'); } catch (e) { return s; } };
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 12 }, () => ABC[crypto.randomInt(ABC.length)]).join('');
const fmt = c => c.match(/.{4}/g).join('-');
// Friendly device name from the browser's user-agent (+ the phone model the app sends when the browser allows it)
function deviceName(ua, hint) {
    ua = String(ua || ''); hint = String(hint || '').replace(/[^\w .+()\/-]/g, '').trim().slice(0, 60);
    const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows PC' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
    let model = hint || ((ua.match(/Android[^;)]*;\s*([^;)]+?)\s*(?:Build|\))/) || [])[1] || '');
    if (model.length < 2) model = '';
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
    return ((model ? `${model} (${os})` : os) + ' / ' + br).slice(0, 120);
}
const meta = req => { const ua = (req.get('user-agent') || '').slice(0, 300), dev = String(req.get('x-device-name') || '').slice(0, 60);
    return { ip: req.ip, ua, device: deviceName(ua, dev), dev }; };
const hm = t => crypto.createHmac('sha256', ID_KEY).update(String(t)).digest('hex');
const isTrue = v => v === true || v === 'true';
const bad = t => /<\s*\/?\s*(script|iframe|svg|object|embed|link|style)|javascript:|\bon(error|load|click|mouseover|focus)\s*=/i.test(t);
const alertMe = m => { console.warn('ALERT:', m);
    if (process.env.TG_TOKEN && process.env.TG_CHAT)
        fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: process.env.TG_CHAT, text: '🚨 Zenith Chads: ' + m }) }).catch(() => {}); };

// ---------- APP ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
const origins = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
if (!origins.length) console.warn('ALLOWED_ORIGIN not set: any website can call this API.');
app.use(cors({ origin: origins.length ? origins : true }));
app.use(express.json({ limit: '20kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
const signupLimit = rateLimit({ windowMs: 24 * 3600_000, limit: +process.env.SIGNUPS_PER_IP_DAY || 100, skipFailedRequests: true, message: { error: 'Too many sign-ups from this network today. Try tomorrow.' } });
const strictLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, message: { error: 'Too many tries. Wait 15 minutes.' } });

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const storage = new CloudinaryStorage({ cloudinary, params: { folder: 'zenith_chads', resource_type: 'auto',
    allowed_formats: ['jpg','jpeg','png','gif','webp','heic','heif','mp4','mov','m4v','webm','3gp','mp3','m4a','aac','wav','ogg'] } });
const upload = multer({ storage, limits: { fileSize: 60 * 1024 * 1024 } });
const uploadMedia = (req, res, next) => upload.single('media')(req, res, err => err
    ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too big. Max 60 MB.' : 'That file type is not supported.' }) : next());

// ---------- DATABASE MODELS ----------
const User = mongoose.model('User', new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },       // public label, NOT a password
    nickname: { type: String, required: true, unique: true },
    nicknameKey: { type: String, unique: true, sparse: true },       // lowercase copy, stops Rahul/rahul
    tokenHash: { type: String, index: true },                        // hash of the secret device key
    recoveryHash: String,
    prefs: { likes: { type: Boolean, default: true }, comments: { type: Boolean, default: true }, posts: { type: Boolean, default: true } },  // which phone alerts they want
    isBanned: { type: Boolean, default: false },
    signupIp: String, signupUa: String,
    lastPostAt: { type: Date, default: 0 }, lastCommentAt: { type: Date, default: 0 },
    createdAt: { type: Date, default: Date.now }
}));
const Post = mongoose.model('Post', new mongoose.Schema({
    content: { type: String, default: '' },
    nickname: { type: String, default: 'Anonymous' },
    realNickname: String, deviceId: String,
    mediaUrl: { type: String, default: null },
    mediaType: { type: String, enum: ['image', 'video', 'audio', null], default: null },
    likes: { type: Number, default: 0 }, likedBy: [String],
    comments: [{ text: String, nickname: { type: String, default: 'Anonymous' }, realNickname: String,
        deviceId: String, ipAddress: String, ua: String, createdAt: { type: Date, default: Date.now } }],
    ipAddress: { type: String, required: true }, ua: String,
    isPinned: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
}));
const Audit = mongoose.model('Audit', new mongoose.Schema({ at: { type: Date, default: Date.now }, action: String, target: String, ip: String }));
const audit = (req, action, target) => Audit.create({ action, target, ip: req.ip }).catch(() => {});
// PERMANENT identity log: one row per person + network + device. Never auto-deleted. IP, user-agent and device name are stored encrypted.
const Identity = mongoose.model('Identity', new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    key: String,                                   // keyed hash of ip+ua+device, so repeat visits update one row
    username: String, deviceId: String,
    ip: String, ua: String, device: String,
    firstSeen: { type: Date, default: Date.now }, lastSeen: { type: Date, default: Date.now }, seen: { type: Number, default: 0 }
}).index({ userId: 1, key: 1 }, { unique: true }));
async function logIdentity(req, u) {
    try {
        const m = meta(req);
        await Identity.updateOne({ userId: u._id, key: hm(`${m.ip}|${m.ua}|${m.dev}`) },
            { $set: { username: u.nickname, deviceId: u.deviceId, lastSeen: new Date() }, $inc: { seen: 1 },
              $setOnInsert: { ip: enc(m.ip), ua: enc(m.ua), device: enc(m.device), firstSeen: new Date() } }, { upsert: true });
    } catch (e) { console.error('identity log failed:', e.message); }
}
// One row per phone/browser that said yes to notifications
const Sub = mongoose.model('Sub', new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, index: true },
    endpoint: { type: String, unique: true },
    keys: { p256dh: String, auth: String },
    createdAt: { type: Date, default: Date.now }
}));
// The bell list inside the app (kept 30 days, then removed automatically)
const noteSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    type: { type: String, enum: ['like', 'comment', 'thread'] },
    postId: mongoose.Schema.Types.ObjectId,
    actor: String,                                   // already anonymity-safe: 'Anonymous' if they commented anonymously
    text: String,
    count: { type: Number, default: 1 },             // likes are grouped: "3 people liked your post"
    read: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, expires: 30 * 86400 }
});
noteSchema.index({ userId: 1, createdAt: -1 });
const Note = mongoose.model('Note', noteSchema);

// Only these fields ever leave the server to normal visitors
const pub = p => ({ _id: p._id, content: p.content, nickname: p.nickname || 'Anonymous', mediaUrl: p.mediaUrl, mediaType: p.mediaType,
    likes: p.likes, isPinned: p.isPinned, createdAt: p.createdAt,
    comments: (p.comments || []).map(c => ({ _id: c._id, text: c.text, nickname: c.nickname || 'Anonymous', createdAt: c.createdAt })) });
const LIST = '-ipAddress -ua -deviceId -realNickname -likedBy';
const ci = { locale: 'en', strength: 2 };
const taken = async c => !!(await User.findOne({ $or: [{ nicknameKey: c.key }, { nickname: c.name }] }).collation(ci).select('_id'));

const auth = async (req, res, next) => {
    const t = req.get('x-device-token');
    const u = t && await User.findOne({ tokenHash: sha(t) });
    if (!u) return res.status(401).json({ error: 'Sign up first.' });
    if (u.isBanned) return res.status(403).json({ error: 'This account is banned.' });
    req.user = u; next();
};

// ---------- NOTIFICATIONS: in-app bell + phone alerts (like Instagram) ----------
const PUSH_ON = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (PUSH_ON) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
else console.warn('VAPID keys missing: phone alerts are OFF (the in-app bell still works). See .env.example');
// Only real browser push services are accepted, so nobody can make this server call random websites
const PUSH_HOSTS = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\//i;
const snip = (t, n = 90) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const wants = (u, k) => !u.prefs || u.prefs[k] !== false;
const inChunks = async (arr, n, fn) => { for (let i = 0; i < arr.length; i += n) await Promise.all(arr.slice(i, i + n).map(fn)); };
const sendPush = (subs, payload, opts = {}) => {
    if (!PUSH_ON || !subs.length) return;
    const body = JSON.stringify(payload);
    return inChunks(subs, 50, async s => {
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 6 * 3600, urgency: 'high', ...opts }); }
        catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await Sub.deleteOne({ endpoint: s.endpoint }).catch(() => {}); }
    });
};

// Saves the bell item for one person, then buzzes their phone(s)
async function tell(user, type, post, actor, text) {
    try {
        let note;
        if (type === 'like') note = await Note.findOneAndUpdate({ userId: user._id, type: 'like', postId: post._id, read: false },
            { $inc: { count: 1 }, $set: { createdAt: new Date() } }, { upsert: true, new: true });
        else note = await Note.create({ userId: user._id, type, postId: post._id, actor, text: snip(text, 300) });
        if (!PUSH_ON || !wants(user, type === 'like' ? 'likes' : 'comments')) return;
        const subs = await Sub.find({ userId: user._id }).lean();
        if (!subs.length) return;
        const unread = await Note.countDocuments({ userId: user._id, read: false });
        const title = type === 'like' ? (note.count > 1 ? `${note.count} people liked your post` : 'Someone liked your post')
            : type === 'thread' ? `${actor} also commented` : `${actor} commented on your post`;
        await sendPush(subs, { type, title, body: type === 'like' ? snip(post.content, 80) : snip(text),
            tag: type === 'like' ? `like-${post._id}` : `c-${note._id}`, postId: String(post._id), badge: unread });
    } catch (e) { console.error('notify failed:', e.message); }
}
// A comment tells the post owner, plus everyone else already chatting on that post
async function noteComment(post, by, actor, text) {
    try {
        const ids = new Set([String(post.deviceId)]);
        (post.comments || []).forEach(c => c.deviceId && ids.add(String(c.deviceId)));
        ids.delete(String(by.deviceId));
        const users = await User.find({ deviceId: { $in: [...ids].slice(0, 25) } });
        for (const u of users) await tell(u, u.deviceId === post.deviceId ? 'comment' : 'thread', post, actor, text);
    } catch (e) { console.error('notify failed:', e.message); }
}
async function noteLike(post, by) {
    try {
        const owner = await User.findOne({ deviceId: post.deviceId });
        if (owner && String(owner._id) !== String(by._id)) await tell(owner, 'like', post, null, '');
    } catch (e) { console.error('notify failed:', e.message); }
}
// A new post tells everyone who kept "New drops" on. At most one blast every DROP_ALERT_GAP_SEC so nobody gets spammed.
let lastDrop = 0;
async function announceDrop(post, author, anon) {
    const gap = (+process.env.DROP_ALERT_GAP_SEC || 120) * 1000;
    if (!PUSH_ON || Date.now() - lastDrop < gap) return;
    lastDrop = Date.now();
    try {
        const users = await User.find({ 'prefs.posts': { $ne: false }, isBanned: { $ne: true }, _id: { $ne: author._id } }).select('_id').lean();
        const subs = await Sub.find({ userId: { $in: users.map(u => u._id) } }).lean();
        await sendPush(subs, { type: 'post', title: anon ? 'New anonymous drop 👀' : `${author.nickname} just dropped something`,
            body: snip(post.content, 100) || 'Photo, video or audio', tag: 'new-drop', postId: String(post._id) }, { TTL: 3600, urgency: 'normal' });
    } catch (e) { console.error('drop alert failed:', e.message); }
}

// ---------- SIGN-UP / SESSION ----------
app.get('/api/username/check', async (req, res) => {
    const c = checkUsername(req.query.name);
    if (!c.ok) return res.json({ ok: false, error: c.error });
    res.json((await taken(c)) ? { ok: false, error: 'That username is taken.' } : { ok: true });
});

// Called on every app open: confirms the device, or upgrades an old account to a secret device key
app.post('/api/session', async (req, res) => {
    const t = req.get('x-device-token');
    if (t) { const u = await User.findOne({ tokenHash: sha(t) }); if (u) { logIdentity(req, u); return res.json({ nickname: u.nickname }); } }
    const legacy = String(req.body.legacyDeviceId || '');
    const u = legacy && await User.findOne({ deviceId: legacy, tokenHash: null });
    if (!u) return res.json({ nickname: null });
    const token = rnd(32), code = newCode();
    Object.assign(u, { tokenHash: sha(token), recoveryHash: sha(code), nicknameKey: u.nickname.toLowerCase() });
    await u.save(); logIdentity(req, u);
    res.json({ nickname: u.nickname, token, recoveryCode: fmt(code) });
});

app.post('/api/register', signupLimit, async (req, res) => {
    const t = req.get('x-device-token');
    if (t && await User.exists({ tokenHash: sha(t) })) return res.status(409).json({ error: 'This device already has a username.' });
    const c = checkUsername(req.body.nickname);
    if (!c.ok) return res.status(400).json({ error: c.error });
    if (await taken(c)) return res.status(400).json({ error: 'That username is taken.' });
    const token = rnd(32), code = newCode(), m = meta(req);
    let nu;
    try { nu = await User.create({ deviceId: 'chad_' + rnd(6), nickname: c.name, nicknameKey: c.key, tokenHash: sha(token),
        recoveryHash: sha(code), signupIp: enc(m.ip), signupUa: enc(m.ua) }); }
    catch (e) { return res.status(400).json({ error: 'That username is taken.' }); }
    logIdentity(req, nu);
    res.status(201).json({ nickname: c.name, token, recoveryCode: fmt(code) });
});

// New phone? username + recovery code moves the account here (the old phone stops working)
app.post('/api/recover', strictLimit, async (req, res) => {
    const name = String(req.body.nickname || '').trim();
    const code = String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const u = name && await User.findOne({ nickname: name }).collation(ci);
    if (!u || !u.recoveryHash || !same(sha(code), u.recoveryHash)) return res.status(400).json({ error: 'Wrong username or code.' });
    const token = rnd(32), fresh = newCode();
    Object.assign(u, { tokenHash: sha(token), recoveryHash: sha(fresh) });
    await u.save(); logIdentity(req, u);
    res.json({ nickname: u.nickname, token, recoveryCode: fmt(fresh) });
});

// ---------- POSTS ----------
app.get('/api/posts', async (req, res) => {
    const page = Math.max(1, +req.query.page || 1);
    const posts = await Post.find().select(LIST).sort({ isPinned: -1, createdAt: -1 }).skip((page - 1) * 30).limit(30).lean();
    res.json(posts.map(pub));
});
app.get('/api/posts/trending', async (req, res) => {
    const posts = await Post.find().select(LIST).sort({ likes: -1, createdAt: -1 }).limit(20).lean();
    res.json(posts.map(pub));
});

const cooldown = (field, ms) => async (req, res, next) => {
    if (Date.now() - req.user[field] < ms) return res.status(429).json({ error: 'Slow down a little.' });
    req.user[field] = new Date(); await req.user.save(); next();
};
app.post('/api/posts', auth, cooldown('lastPostAt', 15000), uploadMedia, async (req, res) => {
    const content = String(req.body.content || '').trim().slice(0, 1000), u = req.user, m = meta(req);
    if (!content && !req.file) return res.status(400).json({ error: 'Write something or add a file.' });
    if (bad(content)) { alertMe(`Code injection attempt by "${u.nickname}" from ${m.ip}`); return res.status(400).json({ error: 'That text is not allowed.' }); }
    const mt = req.file && req.file.mimetype;
    const anon = isTrue(req.body.isAnonymous);
    logIdentity(req, u);
    const post = await Post.create({ content, nickname: anon ? 'Anonymous' : u.nickname, realNickname: u.nickname, deviceId: u.deviceId,
        mediaUrl: req.file ? req.file.path : null, mediaType: mt ? (mt.startsWith('video') ? 'video' : mt.startsWith('audio') ? 'audio' : 'image') : null,
        ipAddress: enc(m.ip), ua: enc(m.ua) });
    res.status(201).json({ message: 'Dropped successfully' });
    announceDrop(post, u, anon);
});

app.post('/api/posts/:id/like', auth, async (req, res) => {
    const uid = String(req.user._id);
    const r = await Post.findOneAndUpdate({ _id: req.params.id, likedBy: { $ne: uid } }, { $inc: { likes: 1 }, $push: { likedBy: uid } });
    res.json({ success: true, counted: !!r });
    if (r) noteLike(r, req.user);
});

app.post('/api/posts/:id/comment', auth, cooldown('lastCommentAt', 4000), async (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 500), u = req.user, m = meta(req);
    if (!text) return res.status(400).json({ error: 'Write something first.' });
    if (bad(text)) { alertMe(`Code injection attempt (comment) by "${u.nickname}" from ${m.ip}`); return res.status(400).json({ error: 'That text is not allowed.' }); }
    const r = await Post.findByIdAndUpdate(req.params.id, { $push: { comments: { text, nickname: isTrue(req.body.isAnonymous) ? 'Anonymous' : u.nickname,
        realNickname: u.nickname, deviceId: u.deviceId, ipAddress: enc(m.ip), ua: enc(m.ua) } } });
    if (!r) return res.status(404).json({ error: 'Post not found.' });
    res.json({ success: true });
    noteComment(r, u, isTrue(req.body.isAnonymous) ? 'Anonymous' : u.nickname, text);
});

// ---------- NOTIFICATION ROUTES ----------
app.get('/api/push/key', (req, res) => res.json({ key: PUSH_ON ? process.env.VAPID_PUBLIC_KEY : null }));
app.post('/api/push/subscribe', auth, async (req, res) => {
    const s = req.body.subscription || {}, k = s.keys || {};
    if (typeof s.endpoint !== 'string' || s.endpoint.length > 700 || !PUSH_HOSTS.test(s.endpoint) ||
        typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 100)
        return res.status(400).json({ error: 'Bad subscription.' });
    await Sub.findOneAndUpdate({ endpoint: s.endpoint }, { userId: req.user._id, keys: { p256dh: k.p256dh, auth: k.auth } }, { upsert: true });
    const extra = await Sub.find({ userId: req.user._id }).sort({ createdAt: -1 }).skip(5).select('_id').lean();   // 5 devices max per person
    if (extra.length) await Sub.deleteMany({ _id: { $in: extra.map(x => x._id) } });
    res.json({ ok: true });
});
app.post('/api/push/unsubscribe', auth, async (req, res) => {
    await Sub.deleteOne({ endpoint: String(req.body.endpoint || ''), userId: req.user._id });
    res.json({ ok: true });
});
app.get('/api/notifications', auth, async (req, res) => {
    const [items, unread] = await Promise.all([
        Note.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(40).lean(),
        Note.countDocuments({ userId: req.user._id, read: false })]);
    const p = req.user.prefs || {};
    res.json({ unread, push: PUSH_ON, prefs: { likes: p.likes !== false, comments: p.comments !== false, posts: p.posts !== false },
        items: items.map(n => ({ _id: n._id, type: n.type, postId: n.postId, actor: n.actor, text: n.text, count: n.count, read: n.read, createdAt: n.createdAt })) });
});
app.post('/api/notifications/read', auth, async (req, res) => {
    await Note.updateMany({ userId: req.user._id, read: false }, { read: true });
    res.json({ ok: true });
});
app.put('/api/notifications/prefs', auth, async (req, res) => {
    for (const k of ['likes', 'comments', 'posts']) if (typeof req.body[k] === 'boolean') req.user.set('prefs.' + k, req.body[k]);
    await req.user.save();
    res.json({ ok: true });
});

// ---------- TRAPS: nobody real ever visits these ----------
app.all(['/api/admin/users', '/api/admin/export', '/api/debug', '/.env', '/wp-admin'], (req, res) => {
    alertMe(`Trap hit: ${req.method} ${req.path} from ${req.ip}`); res.status(404).json({ error: 'Not found' });
});

// ---------- ADMIN (only you) ----------
app.use('/api/admin', rateLimit({ windowMs: 15 * 60_000, limit: 20, skipSuccessfulRequests: true, message: { error: 'Too many tries. Wait 15 minutes.' } }));
app.use('/api/admin', (req, res, next) => {
    if (!ADMIN_OK) return res.status(503).json({ error: 'Admin is off.' });
    if (!same(req.get('x-admin-token') || '', process.env.ADMIN_SECRET)) { alertMe(`Wrong admin password from ${req.ip}`); return res.status(403).json({ error: 'Unauthorized.' }); }
    next();
});
const full = p => ({ ...p, ipAddress: dec(p.ipAddress), ua: dec(p.ua), likedBy: undefined,
    comments: (p.comments || []).map(c => ({ ...c, ipAddress: dec(c.ipAddress), ua: dec(c.ua) })) });

app.get('/api/admin/posts', async (req, res) => {
    const page = Math.max(1, +req.query.page || 1);
    res.json((await Post.find().sort({ createdAt: -1 }).skip((page - 1) * 100).limit(100).lean()).map(full));
});
const idRow = i => ({ username: i.username, deviceId: i.deviceId, ip: dec(i.ip), device: dec(i.device), ua: dec(i.ua), firstSeen: i.firstSeen, lastSeen: i.lastSeen, seen: i.seen });
app.get('/api/admin/identities', async (req, res) => {
    const page = Math.max(1, +req.query.page || 1);
    audit(req, 'identities', 'page ' + page);
    res.json((await Identity.find().sort({ lastSeen: -1 }).skip((page - 1) * 100).limit(100).lean()).map(idRow));
});
app.get('/api/admin/lookup', async (req, res) => {
    const u = await User.findOne({ nickname: String(req.query.nickname || '') }).collation(ci).lean();
    if (!u) return res.status(404).json({ error: 'No such user.' });
    audit(req, 'lookup', u.nickname);
    const posts = await Post.find({ $or: [{ realNickname: u.nickname }, { 'comments.realNickname': u.nickname }] }).sort({ createdAt: -1 }).limit(50).lean();
    const devices = (await Identity.find({ userId: u._id }).sort({ lastSeen: -1 }).lean()).map(idRow);
    res.json({ devices, user: { nickname: u.nickname, deviceId: u.deviceId, isBanned: u.isBanned, createdAt: u.createdAt, signupIp: dec(u.signupIp), signupUa: dec(u.signupUa) },
        posts: posts.map(full), audit: await Audit.find().sort({ at: -1 }).limit(15).lean() });
});
app.delete('/api/admin/posts/:id', async (req, res) => { audit(req, 'delete-post', req.params.id); await Post.findByIdAndDelete(req.params.id); res.json({ message: 'Post erased.' }); });
app.put('/api/admin/posts/:id/pin', async (req, res) => {
    const p = await Post.findById(req.params.id); if (!p) return res.status(404).json({ error: 'Not found.' });
    p.isPinned = !p.isPinned; await p.save(); res.json({ message: 'Pin toggled.' });
});
app.post('/api/admin/users/ban', async (req, res) => {
    audit(req, req.body.banned ? 'ban' : 'unban', req.body.nickname);
    await User.findOneAndUpdate({ nickname: String(req.body.nickname || '') }, { isBanned: !!req.body.banned }).collation(ci);
    res.json({ message: 'Done.' });
});
app.put('/api/admin/users/rename', async (req, res) => {
    audit(req, 'rename', `${req.body.oldName} -> ${req.body.newName}`);
    const ru = await User.findOneAndUpdate({ nickname: req.body.oldName }, { nickname: req.body.newName, nicknameKey: String(req.body.newName).toLowerCase() });
    if (ru) await Identity.updateMany({ userId: ru._id }, { username: req.body.newName });
    res.json({ message: 'User renamed.' });
});

app.use((err, req, res, next) => { console.error(err.message); res.status(err.name === 'CastError' ? 400 : 500).json({ error: 'Something went wrong.' }); });
process.on('unhandledRejection', e => console.error('Unhandled:', e && e.message));

// Posts and comments are deleted after KEEP_POSTS_DAYS (default 90), with their photos/videos. Pinned posts stay.
// Identity records (username, IP, device ID, device name) are in the Identity collection and are NEVER deleted here.
const mediaId = u => (String(u || '').match(/(zenith_chads\/[^./?]+)/) || [])[1];
async function purge() {
    try {
        const cut = new Date(Date.now() - (+process.env.KEEP_POSTS_DAYS || 90) * 864e5);
        for (;;) {
            const old = await Post.find({ createdAt: { $lt: cut }, isPinned: { $ne: true } }).select('mediaUrl mediaType').limit(200).lean();
            if (!old.length) break;
            await Promise.all(old.filter(p => mediaId(p.mediaUrl)).map(p =>
                cloudinary.uploader.destroy(mediaId(p.mediaUrl), { resource_type: p.mediaType === 'image' ? 'image' : 'video' }).catch(() => {})));
            await Post.deleteMany({ _id: { $in: old.map(p => p._id) } });
        }
    } catch (e) { console.error('purge failed:', e.message); }
}

mongoose.connect(process.env.MONGO_URI).then(() => {
    console.log('Connected to Database.'); purge(); setInterval(purge, 6 * 3600_000);
    app.listen(process.env.PORT || 5000, () => console.log('Server running'));
}).catch(e => console.error(e));
