// SnapsaCrew.js — "Work" section on profiles + SNAPSA crew approval + crew shirt artwork.
import mongoose from 'mongoose';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  shirtFrontUrl: { type: String, default: null }, shirtFrontPublicId: { type: String, default: null },
  shirtBackUrl: { type: String, default: null }, shirtBackPublicId: { type: String, default: null },
  layout: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });
const CrewSettings = mongoose.models.SnapsaCrewSettings || mongoose.model('SnapsaCrewSettings', settingsSchema);

export const DEFAULT_LAYOUT = { fx: 31.5, fy: 29, fs: 4.6, bx: 29.6, by: 58, bs: 0, py: 29, ps: 5 };
export const isSnapsaCompany = (name) => /snapsa/i.test(String(name || ''));
const clean = (v, n) => String(v || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

export function registerSnapsaCrew(app, { snapAuth, requireSnapAdmin, uploadLimiter, SnapsaProfile, SnapsaIdentity, sendSnapsaSystemMessage, refreshCrewCache }) {
  const art = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }).single('shirt');

  // User saves (or clears) their current work.
  app.post('/snapsa/profile/work', snapAuth, async (req, res) => {
    try {
      const company = clean(req.body.company, 60), position = clean(req.body.position, 60), start = clean(req.body.start, 7);
      const prof = await SnapsaProfile.findOne({ userId: req.userId });
      if (!prof) return res.status(404).json({ error: 'Profile not found' });
      if (!company) {
        prof.workCompany = ''; prof.workPosition = ''; prof.workStart = ''; prof.workStatus = ''; prof.crewPosition = '';
      } else {
        if (!position) return res.status(400).json({ error: 'Add your position' });
        if (start && !/^\d{4}-(0[1-9]|1[0-2])$/.test(start)) return res.status(400).json({ error: 'Pick a valid start month' });
        const snapsa = isSnapsaCompany(company);
        const sameAsApproved = snapsa && prof.workStatus === 'approved' && prof.workCompany === company && prof.workPosition === position;
        prof.workCompany = company; prof.workPosition = position; prof.workStart = start;
        if (!snapsa) { prof.workStatus = ''; prof.crewPosition = ''; }
        else if (!sameAsApproved) { prof.workStatus = 'pending'; prof.crewPosition = ''; }
        if (snapsa && !sameAsApproved) {
          const admins = await SnapsaIdentity.find({ $or: [{ isAdmin: true }, { founder: true }] }).select('_id').lean();
          for (const a of admins) sendSnapsaSystemMessage?.(String(a._id), `Crew approval needed: @${prof.username} says they work at "${company}" as "${position}". Open Admin → Crew to approve or reject.`);
        }
      }
      await prof.save();
      refreshCrewCache?.();
      res.json({ success: true, work: { company: prof.workCompany, position: prof.workPosition, start: prof.workStart, status: prof.workStatus } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/snapsa/admin/crew', snapAuth, requireSnapAdmin, async (req, res) => {
    try {
      const rows = await SnapsaProfile.find({ workStatus: { $in: ['pending', 'approved'] } }).select('userId username avatarUrl workCompany workPosition workStart workStatus').lean();
      const s = await CrewSettings.findOne({ key: 'main' }).lean();
      const shape = r => ({ userId: String(r.userId), username: r.username, avatarUrl: r.avatarUrl || null, company: r.workCompany, position: r.workPosition, start: r.workStart });
      res.json({ pending: rows.filter(r => r.workStatus === 'pending').map(shape), approved: rows.filter(r => r.workStatus === 'approved').map(shape), shirt: { front: s?.shirtFrontUrl || null, back: s?.shirtBackUrl || null, layout: { ...DEFAULT_LAYOUT, ...(s?.layout || {}) } } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/snapsa/admin/crew/decision', snapAuth, requireSnapAdmin, async (req, res) => {
    try {
      const { userId, action } = req.body;
      const prof = await SnapsaProfile.findOne({ userId });
      if (!prof) return res.status(404).json({ error: 'Not found' });
      if (action === 'approve') {
        const pos = clean(req.body.position, 60) || prof.workPosition;
        prof.workPosition = pos; prof.workStatus = 'approved'; prof.crewPosition = pos;
        sendSnapsaSystemMessage?.(String(prof.userId), `Welcome to the Snapsa crew! Your CREW badge and shirt are now live on your profile.`);
      } else if (action === 'reject') {
        prof.workStatus = 'rejected'; prof.crewPosition = '';
        sendSnapsaSystemMessage?.(String(prof.userId), `Your Snapsa work position was not approved. You can update it from your profile.`);
      } else if (action === 'remove') { prof.workStatus = 'rejected'; prof.crewPosition = ''; }
      else return res.status(400).json({ error: 'Bad action' });
      await prof.save();
      refreshCrewCache?.();
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Shirt artwork: anyone signed in can read it, admins upload front/back.
  app.get('/snapsa/crew/shirt', snapAuth, async (req, res) => {
    const s = await CrewSettings.findOne({ key: 'main' }).lean().catch(() => null);
    res.json({ front: s?.shirtFrontUrl || null, back: s?.shirtBackUrl || null, layout: { ...DEFAULT_LAYOUT, ...(s?.layout || {}) } });
  });
  app.post('/snapsa/admin/crew/shirt-layout', snapAuth, requireSnapAdmin, async (req, res) => {
    const out = {};
    for (const k of Object.keys(DEFAULT_LAYOUT)) { const v = Number(req.body?.[k]); if (Number.isFinite(v) && v >= 0 && v <= 100) out[k] = v; }
    await CrewSettings.updateOne({ key: 'main' }, { $set: { layout: out } }, { upsert: true });
    res.json({ success: true, layout: { ...DEFAULT_LAYOUT, ...out } });
  });
  app.post('/snapsa/admin/crew/shirt/:side', snapAuth, requireSnapAdmin, uploadLimiter, art, async (req, res) => {
    try {
      const side = req.params.side === 'back' ? 'Back' : 'Front';
      if (!req.file) return res.status(400).json({ error: 'Choose an image' });
      if (!/^image\/(png|jpe?g|webp)$/.test(req.file.mimetype)) return res.status(400).json({ error: 'PNG, JPG or WebP only' });
      const up = await new Promise((ok, no) => cloudinary.uploader.upload_stream({ folder: 'snapsa/crew', resource_type: 'image' }, (e, r) => e ? no(e) : ok(r)).end(req.file.buffer));
      const prev = await CrewSettings.findOneAndUpdate({ key: 'main' }, { $set: { [`shirt${side}Url`]: up.secure_url, [`shirt${side}PublicId`]: up.public_id } }, { upsert: true, new: false }).lean();
      if (prev?.[`shirt${side}PublicId`]) cloudinary.uploader.destroy(prev[`shirt${side}PublicId`]).catch(() => {});
      res.json({ success: true, url: up.secure_url });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/snapsa/admin/crew/shirt/:side/remove', snapAuth, requireSnapAdmin, async (req, res) => {
    const side = req.params.side === 'back' ? 'Back' : 'Front';
    const prev = await CrewSettings.findOneAndUpdate({ key: 'main' }, { $set: { [`shirt${side}Url`]: null, [`shirt${side}PublicId`]: null } }, { new: false }).lean();
    if (prev?.[`shirt${side}PublicId`]) cloudinary.uploader.destroy(prev[`shirt${side}PublicId`]).catch(() => {});
    res.json({ success: true });
  });
}
