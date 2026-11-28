// SnapsaGroups.js — Snapsa group chats: create (any size, even with no members yet), members & admins, invite code,
// text / photo / video / voice / file messages, reactions, replies, anonymous "ghost" messages, exclusive messages.
// Not encrypted (as requested). Chat lock is on the phone, like private chats.
import mongoose from 'mongoose';
import crypto from 'crypto';

const clean = (v, n) => String(v || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const oid = (s) => new mongoose.Types.ObjectId(String(s));
const isOid = (s) => mongoose.Types.ObjectId.isValid(String(s));
const uniq = (a) => [...new Set(a.map(String))];
const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🔥'];

export function registerSnapsaGroups(app, deps) {
  const { snapAuth, uploadLimiter, uploadMessageMedia, uploadToCloudinary, cleanupTempFiles, config, SnapsaProfile, sendPushToUser, broadcastToUser, mediaUrl, path, fs, uuidv4, isSnapUserOnline } = deps;

  const groupSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String, default: '' },
    photoFile: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, index: true },
    admins: [{ type: mongoose.Schema.Types.ObjectId }],
    members: [{ type: mongoose.Schema.Types.ObjectId }],
    inviteCode: { type: String, index: true },
    lastMessageAt: { type: Date, default: Date.now },
    lastPreview: { type: String, default: '' },
    reads: { type: mongoose.Schema.Types.Mixed, default: {} },
  }, { timestamps: true, collection: 'snapsa_groups', minimize: false });
  groupSchema.index({ members: 1, lastMessageAt: -1 });
  const Group = mongoose.models.SnapsaGroup || mongoose.model('SnapsaGroup', groupSchema);

  const msgSchema = new mongoose.Schema({
    groupId: { type: mongoose.Schema.Types.ObjectId, index: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, default: null },       // null for ghost messages
    ghost: { type: Boolean, default: false },
    ghostToken: { type: String, default: '' },
    ghostDay: { type: String, default: '' },
    type: { type: String, enum: ['text', 'photo', 'video', 'voice', 'file', 'system'], default: 'text' },
    text: { type: String, default: '' },
    mediaFile: { type: String, default: '' },
    fileName: { type: String, default: '' },
    duration: { type: Number, default: 0 },
    replyTo: { type: mongoose.Schema.Types.Mixed, default: null },
    exclusive: { type: Boolean, default: false },
    visibleTo: [{ type: mongoose.Schema.Types.ObjectId }],
    reactions: [{ userId: mongoose.Schema.Types.ObjectId, emoji: String }],
    deletedForEveryone: { type: Boolean, default: false },
  }, { timestamps: true, collection: 'snapsa_group_messages' });
  msgSchema.index({ groupId: 1, createdAt: 1 });
  const GroupMsg = mongoose.models.SnapsaGroupMsg || mongoose.model('SnapsaGroupMsg', msgSchema);

  // one-way anonymous id: same person + same group + same day = same token, but it can not be turned back into the person
  const day = () => new Date().toISOString().slice(0, 10);
  const ghostToken = (uid, gid, d) => crypto.createHmac('sha256', String(config.jwtSecret || 'snapsa')).update(`ghost|${uid}|${gid}|${d}`).digest('hex').slice(0, 24);

  const briefs = async (ids) => {
    const list = uniq(ids).filter(isOid);
    if (!list.length) return new Map();
    const rows = await SnapsaProfile.find({ userId: { $in: list.map(oid) } }).select('userId username displayName avatarUrl crewPosition officialLabel snapsaTier').lean();
    return new Map(rows.map(p => [String(p.userId), { id: String(p.userId), username: p.username || '', name: p.displayName || p.username || 'Member', avatarUrl: p.avatarUrl || null, crew: p.crewPosition || '', official: p.officialLabel || '', tier: p.snapsaTier || '' }]));
  };

  const getMine = async (req, res) => {
    if (!req.userId) { res.status(401).json({ error: 'Sign in required' }); return null; }
    if (!isOid(req.params.id)) { res.status(400).json({ error: 'Invalid group' }); return null; }
    const g = await Group.findById(req.params.id);
    if (!g || !g.members.some(m => String(m) === String(req.userId))) { res.status(404).json({ error: 'Group not found' }); return null; }
    return g;
  };
  const isAdmin = (g, uid) => g.admins.some(a => String(a) === String(uid));

  const shapeGroup = (g, uid, extra = {}) => ({
    id: String(g._id), name: g.name, description: g.description || '', photoUrl: g.photoFile ? mediaUrl({ headers: {}, protocol: 'https', get: () => '' }, g.photoFile) : null,
    memberCount: g.members.length, isAdmin: isAdmin(g, uid), lastMessageAt: g.lastMessageAt, lastPreview: g.lastPreview || '',
    ...(isAdmin(g, uid) ? { inviteCode: g.inviteCode } : {}), ...extra,
  });

  const sys = async (g, text) => {
    const m = await GroupMsg.create({ groupId: g._id, type: 'system', text });
    g.lastMessageAt = new Date(); g.lastPreview = text.slice(0, 80); await g.save().catch(() => {});
    return m;
  };
  const nameOf = async (uid) => (await briefs([uid])).get(String(uid))?.username || 'Someone';
  const tell = (g, exceptId, payload) => g.members.forEach(m => { if (String(m) !== String(exceptId)) { try { broadcastToUser(String(m), payload); } catch {} } });
  const newCode = () => crypto.randomBytes(6).toString('base64url');

  const shapeMsg = (m, viewerId, bmap, req, gid) => {
    const mine = m.ghost ? (m.ghostToken && ghostToken(viewerId, gid, m.ghostDay) === m.ghostToken) : String(m.senderId) === String(viewerId);
    const counts = {};
    (m.reactions || []).forEach(r => { counts[r.emoji] = counts[r.emoji] || { emoji: r.emoji, count: 0, mine: false }; counts[r.emoji].count++; if (String(r.userId) === String(viewerId)) counts[r.emoji].mine = true; });
    const base = { id: String(m._id), type: m.type, createdAt: m.createdAt, mine: !!mine, ghost: !!m.ghost, reactions: Object.values(counts), replyTo: m.replyTo || null, deleted: !!m.deletedForEveryone };
    if (m.type === 'system') return { ...base, text: m.text };
    const s = !m.ghost && m.senderId ? bmap.get(String(m.senderId)) : null;
    const who = s ? { senderId: s.id, senderName: s.name, senderUsername: s.username, avatarUrl: s.avatarUrl, crew: s.crew, official: s.official } : {};
    if (m.deletedForEveryone) return { ...base, ...who, text: '', mediaUrl: null };
    const allowed = mine || (m.visibleTo || []).some(x => String(x) === String(viewerId));
    if (m.exclusive && !allowed) return { ...base, ...who, exclusive: true, hidden: true, text: '', mediaUrl: null };
    return { ...base, ...who, text: m.text, mediaUrl: mediaUrl(req, m.mediaFile), fileName: m.fileName, duration: m.duration, exclusive: !!m.exclusive, exclusiveCount: m.exclusive ? m.visibleTo.length : 0 };
  };

  // ───────────── create / list / read ─────────────
  app.post('/snapsa/groups', snapAuth, uploadLimiter, uploadMessageMedia.single('media'), async (req, res) => {
    let tempPath = null;
    try {
      if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
      const name = clean(req.body.name, 40);
      if (!name) return res.status(400).json({ error: 'Give the group a name' });
      let ids = [];
      try { ids = JSON.parse(req.body.memberIds || '[]'); } catch { ids = []; }
      ids = uniq([...(Array.isArray(ids) ? ids : []), req.userId]).filter(isOid);           // no minimum and no maximum
      const found = await SnapsaProfile.find({ userId: { $in: ids.map(oid) } }).select('userId').lean();
      const ok = new Set(found.map(p => String(p.userId))); ok.add(String(req.userId));
      const members = ids.filter(i => ok.has(i)).map(oid);
      let photoFile = '';
      if (req.file && req.file.mimetype.startsWith('image/')) {
        const tempDir = path.join(config.uploadDir, 'temp'); fs.mkdirSync(tempDir, { recursive: true });
        tempPath = path.join(tempDir, `grp_${uuidv4()}${path.extname(req.file.originalname) || '.jpg'}`);
        fs.writeFileSync(tempPath, req.file.buffer);
        photoFile = (await uploadToCloudinary(tempPath, { resourceType: 'image', folder: 'snapsa/groups' })).secure_url; cleanupTempFiles(tempPath);
      }
      const g = await Group.create({ name, description: clean(req.body.description, 200), photoFile, createdBy: oid(req.userId), admins: [oid(req.userId)], members, inviteCode: newCode() });
      await sys(g, `@${await nameOf(req.userId)} created the group "${name}"`);
      tell(g, req.userId, { type: 'snapsa_group', groupId: String(g._id) });
      res.json({ success: true, group: shapeGroup(g, req.userId) });
    } catch (e) { cleanupTempFiles(tempPath); console.error('[group-create]', e.message); res.status(500).json({ error: e.message }); }
  });

  app.get('/snapsa/groups', snapAuth, async (req, res) => {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
      const rows = await Group.find({ members: oid(req.userId) }).sort({ lastMessageAt: -1 }).limit(100);
      const out = [];
      for (const g of rows) {
        const seen = g.reads?.[String(req.userId)] ? new Date(g.reads[String(req.userId)]) : g.createdAt;
        const unread = await GroupMsg.countDocuments({ groupId: g._id, createdAt: { $gt: seen }, type: { $ne: 'system' }, senderId: { $ne: oid(req.userId) }, deletedForEveryone: false });
        out.push(shapeGroup(g, req.userId, { unread }));
      }
      res.json({ groups: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/snapsa/groups/:id', snapAuth, async (req, res) => {
    try {
      const g = await getMine(req, res); if (!g) return;
      const b = await briefs(g.members);
      const members = g.members.map(m => ({ ...(b.get(String(m)) || { id: String(m), username: 'member', name: 'Member' }), isAdmin: isAdmin(g, m) }))
        .sort((a, c) => (c.isAdmin - a.isAdmin) || a.username.localeCompare(c.username));
      // who is online right now — respects each person's privacy (activity status off / restricted = hidden)
      const profs = await SnapsaProfile.find({ userId: { $in: g.members } }).select('userId lastActiveAt privacy.showActivityStatus defconLevel').lean().catch(() => []);
      const pm = new Map(profs.map(p => [String(p.userId), p]));
      await Promise.all(members.map(async m => {
        const p = pm.get(String(m.id)), self = String(m.id) === String(req.userId);
        const share = self || (p?.privacy?.showActivityStatus !== false && (p?.defconLevel || 5) > 4);
        m.online = share && isSnapUserOnline ? !!(await isSnapUserOnline(m.id)) : false;
        m.lastActiveAt = share ? (p?.lastActiveAt || null) : null;
      }));
      res.json({ group: shapeGroup(g, req.userId), members });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ───────────── messages ─────────────
  app.get('/snapsa/groups/:id/messages', snapAuth, async (req, res) => {
    try {
      const g = await getMine(req, res); if (!g) return;
      const rows = await GroupMsg.find({ groupId: g._id }).sort({ createdAt: -1 }).limit(300).lean();
      rows.reverse();
      const rb = await briefs(rows.map(m => m.senderId).filter(Boolean));
      g.reads = { ...(g.reads || {}), [String(req.userId)]: new Date() }; g.markModified('reads'); await g.save().catch(() => {});
      // read receipts on my messages: who has opened the group since the message was sent
      const mb = await briefs(g.members);
      const reads = g.reads || {};
      const out = rows.map(m => {
        const o = shapeMsg(m, req.userId, rb, req, String(g._id));
        if (o.mine && o.type !== 'system' && !o.deleted) {
          const pool = (m.exclusive && m.visibleTo?.length ? m.visibleTo.map(String) : g.members.map(String)).filter(u => u !== String(req.userId));
          const readers = pool.filter(u => reads[u] && new Date(reads[u]) >= new Date(m.createdAt)).map(u => ({ name: mb.get(u)?.name || 'Member', at: reads[u] }));
          o.receipt = { total: pool.length, read: readers.length, readers };
        }
        return o;
      });
      res.json({ messages: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/snapsa/groups/:id/messages', snapAuth, uploadLimiter, uploadMessageMedia.single('media'), async (req, res) => {
    let tempPath = null;
    try {
      const g = await getMine(req, res); if (!g) return;
      const text = String(req.body.text || '').slice(0, 4000);
      if (!text.trim() && !req.file) return res.status(400).json({ error: 'Nothing to send' });
      let type = 'text', mediaFile = '', fileName = '';
      if (req.file) {
        const asFile = req.body.asFile === '1' || !/^(video|audio|image)\//.test(req.file.mimetype);
        type = asFile ? 'file' : req.file.mimetype.startsWith('video/') ? 'video' : req.file.mimetype.startsWith('audio/') ? 'voice' : 'photo';
        const tempDir = path.join(config.uploadDir, 'temp'); fs.mkdirSync(tempDir, { recursive: true });
        const ext = path.extname(req.file.originalname) || (type === 'voice' ? '.webm' : type === 'video' ? '.mp4' : type === 'file' ? '.bin' : '.jpg');
        tempPath = path.join(tempDir, `gm_${uuidv4()}${ext}`); fs.writeFileSync(tempPath, req.file.buffer);
        const up = await uploadToCloudinary(tempPath, { resourceType: type === 'photo' ? 'image' : type === 'file' ? 'raw' : 'video', folder: 'snapsa/groups/messages' });
        mediaFile = up.secure_url; fileName = type === 'file' ? clean(req.file.originalname, 120) : ''; cleanupTempFiles(tempPath);
      }
      const ghost = req.body.ghost === '1';
      let reply = null;
      if (isOid(req.body.replyToId)) {
        const r = await GroupMsg.findOne({ _id: req.body.replyToId, groupId: g._id }).lean();
        if (r && !r.deletedForEveryone && !(r.exclusive && !(r.visibleTo || []).some(x => String(x) === String(req.userId)) && String(r.senderId) !== String(req.userId))) {
          const rs = r.ghost ? null : (await briefs([r.senderId])).get(String(r.senderId));
          reply = { id: String(r._id), text: r.type === 'text' ? String(r.text).slice(0, 90) : ({ photo: '📷 Photo', video: '🎬 Video', voice: '🎤 Voice message', file: '📎 File' })[r.type] || '', senderName: rs ? rs.name : '👻 Ghost' };
        }
      }
      let visibleTo = [], exclusive = false;
      try { const ex = JSON.parse(req.body.exclusiveTo || '[]'); if (Array.isArray(ex) && ex.length) { visibleTo = uniq(ex).filter(i => g.members.some(m => String(m) === i) && i !== String(req.userId)).map(oid); exclusive = visibleTo.length > 0; } } catch {}
      const d = day();
      const m = await GroupMsg.create({
        groupId: g._id, senderId: ghost ? null : oid(req.userId), ghost, ghostToken: ghost ? ghostToken(req.userId, String(g._id), d) : '', ghostDay: ghost ? d : '',
        type, text, mediaFile, fileName, duration: Math.max(0, Math.min(3600, Number(req.body.duration) || 0)), replyTo: reply, exclusive, visibleTo,
      });
      g.lastMessageAt = new Date(); g.reads = { ...(g.reads || {}), [String(req.userId)]: new Date() }; g.markModified('reads');
      g.lastPreview = exclusive ? '🔒 Exclusive message' : ghost ? '👻 Ghost message' : type === 'text' ? text.slice(0, 80) : ({ photo: '📷 Photo', video: '🎬 Video', voice: '🎤 Voice message', file: '📎 File' })[type];
      await g.save().catch(() => {});
      const bmap = await briefs([req.userId]);
      const out = shapeMsg(m.toObject(), req.userId, bmap, req, String(g._id));
      // tell everyone else (live + push)
      const sender = ghost ? '👻 Someone' : `@${bmap.get(String(req.userId))?.username || 'member'}`;
      const body = exclusive ? '🔒 Sent an exclusive message' : type === 'text' ? text.slice(0, 100) : g.lastPreview;
      g.members.forEach(mem => {
        if (String(mem) === String(req.userId)) return;
        const isTarget = !exclusive || visibleTo.some(v => String(v) === String(mem));
        try { broadcastToUser(String(mem), { type: 'snapsa_group', groupId: String(g._id) }); } catch {}
        if (isTarget) Promise.resolve(sendPushToUser(String(mem), { title: `${g.name}`, body: `${sender}: ${body}`, data: { type: 'new_group_message', groupId: String(g._id) } })).catch(() => {});
      });
      res.json({ success: true, message: out });
    } catch (e) { cleanupTempFiles(tempPath); console.error('[group-send]', e.message); res.status(500).json({ error: e.message }); }
  });

  app.post('/snapsa/groups/:id/messages/:mid/react', snapAuth, async (req, res) => {
    try {
      const g = await getMine(req, res); if (!g) return;
      const emoji = String(req.body.emoji || ''); if (!REACTIONS.includes(emoji) || !isOid(req.params.mid)) return res.status(400).json({ error: 'Bad reaction' });
      const m = await GroupMsg.findOne({ _id: req.params.mid, groupId: g._id }); if (!m || m.deletedForEveryone) return res.status(404).json({ error: 'Message not found' });
      const had = m.reactions.find(r => String(r.userId) === String(req.userId));
      m.reactions = m.reactions.filter(r => String(r.userId) !== String(req.userId));
      if (!had || had.emoji !== emoji) m.reactions.push({ userId: oid(req.userId), emoji });
      await m.save(); tell(g, req.userId, { type: 'snapsa_group', groupId: String(g._id) });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/snapsa/groups/:id/messages/:mid', snapAuth, async (req, res) => {
    try {
      const g = await getMine(req, res); if (!g) return;
      if (!isOid(req.params.mid)) return res.status(400).json({ error: 'Bad message' });
      const m = await GroupMsg.findOne({ _id: req.params.mid, groupId: g._id }); if (!m) return res.status(404).json({ error: 'Message not found' });
      const mine = m.ghost ? (m.ghostToken && ghostToken(req.userId, String(g._id), m.ghostDay) === m.ghostToken) : String(m.senderId) === String(req.userId);
      if (!mine && !isAdmin(g, req.userId)) return res.status(403).json({ error: 'Only the sender or a group admin can delete this' });
      m.deletedForEveryone = true; m.text = ''; m.mediaFile = ''; await m.save();
      tell(g, req.userId, { type: 'snapsa_group', groupId: String(g._id) });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ───────────── members & settings ─────────────
  app.patch('/snapsa/groups/:id', snapAuth, async (req, res) => {
    try {
      const g = await getMine(req, res); if (!g) return;
      if (!isAdmin(g, req.userId)) return res.status(403).json({ error: 'Only admins can change the group' });
      if (req.body.name !== undefined) { const n = clean(req.body.name, 40); if (!n) return res.status(400).json({ error: 'Give the group a name' }); g.name = n; }
      if (req.body.description !== undefined) g.description = clean(req.body.description, 200);
      await g.save(); res.json({ success: true, group: shapeGroup(g, req.userId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/snapsa/groups/:id/photo', snapAuth, uploadLimiter, uploadMessageMedia.single('media'), async (req, res) => {
    let tempPath = null;
    try {
      const g = await getMine(req, res); if (!g) return;
      if (!isAdmin(g, req.userId)) return res.status(403).json({ error: 'Only admins can change the photo' });
      if (!req.file || !req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'Choose a photo' });
      const tempDir = path.join(config.uploadDir, 'temp'); fs.mkdirSync(tempDir, { recursive: true });
      tempPath = path.join(tempDir, `grp_${uuidv4()}${path.extname(req.file.originalname) || '.jpg'}`); fs.writeFileSync(tempPath, req.file.buffer);
      g.photoFile = (await uploadToCloudinary(tempPath, { resourceType: 'image', folder: 'snapsa/groups' })).secure_url; cleanupTempFiles(tempPath);
      await g.save(); res.json({ success: true, group: shapeGroup(g, req.userId) });
    } catch (e) { cleanupTempFiles(tempPath); res.status(500).json({ error: e.message }); }
  });

  app.post('/snapsa/groups/:id/members', snapAuth, async (req, res) => {
    try {
      const g = await getMine(req, res); if (!g) return;
      if (!isAdmin(g, req.userId)) return res.status(403).json({ error: 'Only admins can add people' });
      const ids = uniq(Array.isArray(req.body.userIds) ? req.body.userIds : []).filter(i => isOid(i) && !g.members.some(m => String(m) === i));
      const found = await SnapsaProfile.find({ userId: { $in: ids.map(oid) } }).select('userId username').lean();
      if (!found.length) return res.json({ success: true, added: 0 });
      g.members.push(...found.map(p => oid(p.userId))); await g.save();
      await sys(g, `@${await nameOf(req.userId)} added ${found.map(p => '@' + p.username).join(', ')}`);
      found.forEach(p => { try { broadcastToUser(String(p.userId), { type: 'snapsa_group', groupId: String(g._id) }); } catch {} });
      res.json({ success: true, added: found.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const removeMember = async (g, uid, byId, selfLeave) => {
    g.members = g.members.filter(m => String(m) !== String(uid)); g.admins = g.admins.filter(a => String(a) !== String(uid));
    if (g.members.length === 0) { await GroupMsg.deleteMany({ groupId: g._id }); await Group.deleteOne({ _id: g._id }); return; }
    if (g.admins.length === 0) g.admins = [g.members[0]];       // a group is never left without an admin
    await g.save();
    const who = await nameOf(uid);
    await sys(g, selfLeave ? `@${who} left` : `@${await nameOf(byId)} removed @${who}`);
    try { broadcastToUser(String(uid), { type: 'snapsa_group', groupId: String(g._id) }); } catch {}
  };
  app.post('/snapsa/groups/:id/leave', snapAuth, async (req, res) => { try { const g = await getMine(req, res); if (!g) return; await removeMember(g, req.userId, req.userId, true); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.delete('/snapsa/groups/:id/members/:uid', snapAuth, async (req, res) => {
    try {
      const g = await getMine(req, res); if (!g) return;
      if (!isAdmin(g, req.userId)) return res.status(403).json({ error: 'Only admins can remove people' });
      if (!isOid(req.params.uid) || !g.members.some(m => String(m) === req.params.uid)) return res.status(404).json({ error: 'Not a member' });
      await removeMember(g, req.params.uid, req.userId, String(req.params.uid) === String(req.userId)); res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/snapsa/groups/:id/admins/:uid', snapAuth, async (req, res) => {
    try {
      const g = await getMine(req, res); if (!g) return;
      if (!isAdmin(g, req.userId)) return res.status(403).json({ error: 'Only admins can do this' });
      if (!isOid(req.params.uid) || !g.members.some(m => String(m) === req.params.uid)) return res.status(404).json({ error: 'Not a member' });
      const make = req.body.admin !== false;
      g.admins = make ? uniq([...g.admins, req.params.uid]).map(oid) : g.admins.filter(a => String(a) !== req.params.uid);
      if (g.admins.length === 0) return res.status(400).json({ error: 'A group needs at least one admin' });
      await g.save(); await sys(g, `@${await nameOf(req.params.uid)} ${make ? 'is now an admin' : 'is no longer an admin'}`);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/snapsa/groups/:id/invite/reset', snapAuth, async (req, res) => {
    try { const g = await getMine(req, res); if (!g) return; if (!isAdmin(g, req.userId)) return res.status(403).json({ error: 'Only admins can do this' }); g.inviteCode = newCode(); await g.save(); res.json({ success: true, inviteCode: g.inviteCode }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/snapsa/groups-join', snapAuth, async (req, res) => {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Sign in required' });
      const g = await Group.findOne({ inviteCode: String(req.body.code || '').trim() });
      if (!g) return res.status(404).json({ error: 'That invite code is not valid' });
      if (!g.members.some(m => String(m) === String(req.userId))) { g.members.push(oid(req.userId)); await g.save(); await sys(g, `@${await nameOf(req.userId)} joined with the invite link`); }
      res.json({ success: true, group: shapeGroup(g, req.userId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
