import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { tenantPlugin } from '../../common/tenancy.js';

// Every admin-panel write is recorded here: who did what to which record, and why.
// Entries form a SHA-256 hash chain per tenant (each hash covers the previous one), so editing
// or deleting an old entry is detectable with verifyAuditChain().
const auditLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true }, // e.g. vendor.approve, user.suspend, post.hide
    targetType: String,
    targetId: mongoose.Schema.Types.ObjectId,
    reason: String,
    meta: mongoose.Schema.Types.Mixed,
    ip: String,
    seq: Number,
    prevHash: String,
    hash: String,
  },
  // minimize: false keeps empty objects in meta, so what is stored is exactly what was hashed.
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);
auditLogSchema.plugin(tenantPlugin);
auditLogSchema.index({ tenant: 1, createdAt: -1 });
auditLogSchema.index({ tenant: 1, targetType: 1, targetId: 1 });
// Two writers racing for the same position in the chain: the loser retries on the next one.
auditLogSchema.index({ tenant: 1, seq: 1 }, { unique: true, partialFilterExpression: { seq: { $type: 'number' } } });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);

const GENESIS = '0'.repeat(64);
const str = (v) => (v === undefined || v === null ? null : String(v));

// Fields are hashed in a fixed order so the digest does not depend on key order in storage.
export function auditHash(entry) {
  const payload = JSON.stringify([
    entry.seq,
    entry.prevHash,
    str(entry.actor),
    entry.action,
    str(entry.targetType),
    str(entry.targetId),
    str(entry.reason),
    entry.meta ?? null,
    str(entry.ip),
    new Date(entry.createdAt).toISOString(),
  ]);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export async function audit(req, action, target = {}, extra = {}) {
  for (let attempt = 0; ; attempt++) {
    const last = await AuditLog.findOne({ seq: { $type: 'number' } }).sort({ seq: -1 }).select('seq hash').lean();
    const entry = {
      actor: req.user._id,
      action,
      targetType: target.type,
      targetId: target.id,
      reason: extra.reason,
      meta: extra.meta,
      ip: req.ip,
      seq: (last?.seq ?? 0) + 1,
      prevHash: last?.hash ?? GENESIS,
      createdAt: new Date(),
    };
    // Round-trip meta through JSON so the hash covers exactly what is stored (ObjectIds, Dates → strings).
    if (entry.meta !== undefined) entry.meta = JSON.parse(JSON.stringify(entry.meta));
    entry.hash = auditHash(entry);
    try {
      return await AuditLog.create(entry);
    } catch (err) {
      if (err.code !== 11000 || attempt >= 5) throw err;
    }
  }
}

// Walks the chain in order and reports the first entry whose hash or link does not match.
// Entries written before hashing was introduced (no seq) are skipped.
export async function verifyAuditChain({ limit } = {}) {
  let prevHash = null;
  let checked = 0;
  let query = AuditLog.find({ seq: { $type: 'number' } }).sort({ seq: limit ? -1 : 1 });
  if (limit) query = query.limit(limit);
  let entries = await query.lean();
  if (limit) entries = entries.reverse();

  for (const entry of entries) {
    if (prevHash !== null && entry.prevHash !== prevHash) {
      return { ok: false, checked, brokenAt: { seq: entry.seq, id: entry._id, problem: 'link' } };
    }
    if (auditHash(entry) !== entry.hash) {
      return { ok: false, checked, brokenAt: { seq: entry.seq, id: entry._id, problem: 'hash' } };
    }
    prevHash = entry.hash;
    checked += 1;
  }
  const head = entries.at(-1);
  return { ok: true, checked, head: head ? { seq: head.seq, hash: head.hash, at: head.createdAt } : null };
}
