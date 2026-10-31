import { Router } from 'express';
import mongoose from 'mongoose';
import { authenticate } from '../../common/auth.js';
import { notFound, unavailable } from '../../common/errors.js';
import { tenantPlugin } from '../../common/tenancy.js';
import { objectId, validate } from '../../common/validate.js';
import { env } from '../../config/env.js';
import { HealthRecord, Pet } from '../pets/pet.model.js';

const router = Router();

const aiUsageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    feature: { type: String, required: true },
    provider: String,
    inputTokens: Number,
    outputTokens: Number,
    ok: Boolean,
    error: String,
  },
  { timestamps: true },
);
aiUsageSchema.plugin(tenantPlugin);
export const AiUsage = mongoose.model('AiUsage', aiUsageSchema);

// Phase 1 "record assistance": summarise a pet's health timeline. All AI calls go through the
// server so provider keys never reach the apps, and only the fields listed here leave the
// platform — no owner name, phone, address or attachments. Nurvia has not chosen a provider
// yet; add it in `complete()` once it is approved and disclosed in the privacy policy.
async function complete(_prompt) {
  throw unavailable(`AI provider "${env.ai.provider}" is not configured`);
}

router.post('/pets/:petId/health-summary', authenticate, validate({ params: { petId: objectId } }), async (req, res) => {
  const pet = await Pet.findOne({ _id: req.valid.params.petId, owner: req.user._id, archivedAt: null }).lean();
  if (!pet) throw notFound('Pet');
  const records = await HealthRecord.find({ pet: pet._id }).sort({ date: -1 }).limit(50).select('type title date nextDueDate details notes').lean();

  const prompt = {
    pet: { species: pet.species, breed: pet.breed, sex: pet.sex, dateOfBirth: pet.dateOfBirth, weightKg: pet.weightKg, allergies: pet.allergies },
    records,
  };
  const usage = { user: req.user._id, feature: 'health_summary', provider: env.ai.provider };
  try {
    const result = await complete(prompt);
    await AiUsage.create({ ...usage, ok: true, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    res.json({ summary: result.text, disclaimer: 'AI-generated summary. Not a substitute for veterinary advice.' });
  } catch (err) {
    await AiUsage.create({ ...usage, ok: false, error: err.message });
    throw err;
  }
});

export default router;
