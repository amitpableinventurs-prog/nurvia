import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authenticate, can } from '../../common/auth.js';
import { badRequest, forbidden, notFound } from '../../common/errors.js';
import { PERMISSIONS } from '../../common/roles.js';
import { currentTenant } from '../../common/tenancy.js';
import { validate } from '../../common/validate.js';
import { privatePath, publicUrl, putObject } from '../../integrations/storage.js';
import { File } from './file.model.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.uploads.maxBytes, files: 1 } });

// Health records and KYC documents are personal data, so they are never publicly addressable.
const PRIVATE_PURPOSES = new Set(['health_record', 'vendor_kyc', 'seller_kyc']);
const PDF_PURPOSES = new Set(['health_record', 'vendor_kyc', 'seller_kyc', 'visit_report']);

// The client-declared content type is not trusted; the type is taken from the file's magic bytes.
export function sniff(buffer) {
  const hex = buffer.subarray(0, 12).toString('hex');
  if (hex.startsWith('ffd8ff')) return { mime: 'image/jpeg', ext: 'jpg' };
  if (hex.startsWith('89504e470d0a1a0a')) return { mime: 'image/png', ext: 'png' };
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return { mime: 'image/webp', ext: 'webp' };
  if (hex.startsWith('255044462d')) return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

router.post(
  '/',
  authenticate,
  upload.single('file'),
  validate({ body: { purpose: z.enum(File.schema.path('purpose').enumValues) } }),
  async (req, res) => {
    if (!req.file) throw badRequest('Attach the file in a multipart field named "file"');
    const file = await saveFile({ owner: req.user._id, purpose: req.valid.body.purpose, buffer: req.file.buffer, originalName: req.file.originalname });
    res.status(201).json(file);
  },
);

// Stores an uploaded file for `owner` and returns its record.
export async function saveFile({ owner, purpose, buffer, originalName }) {
  const type = sniff(buffer);
  if (!type) throw badRequest('Only JPEG, PNG, WebP and PDF files are accepted');
  if (type.mime === 'application/pdf' && !PDF_PURPOSES.has(purpose)) throw badRequest('PDFs are only accepted for documents');

  const visibility = PRIVATE_PURPOSES.has(purpose) ? 'private' : 'public';
  const key = `${currentTenant()}/${purpose}/${crypto.randomUUID()}.${type.ext}`;
  await putObject(visibility, key, buffer);

  return File.create({
    owner,
    purpose,
    visibility,
    key,
    url: visibility === 'public' ? publicUrl(key) : undefined,
    originalName: originalName?.slice(0, 200),
    mime: type.mime,
    size: buffer.length,
  });
}

// Private files are streamed only to their owner, plus KYC documents to staff who review vendors.
// Health-record files are deliberately visible to their owner alone.
router.get('/:id', authenticate, validate(), async (req, res) => {
  const file = await File.findById(req.valid.params.id).lean();
  if (!file) throw notFound('File');
  if (file.visibility === 'public') return res.redirect(file.url);

  const isOwner = String(file.owner) === String(req.user._id);
  const isKycReviewer = file.purpose === 'vendor_kyc' && can(req.user, PERMISSIONS.VENDORS_READ);
  if (!isOwner && !isKycReviewer) throw forbidden();

  res.set('Cache-Control', 'private, no-store');
  res.type(file.mime).sendFile(privatePath(file.key));
});

export default router;

// Resolves file ids submitted by a user into attachment sub-documents, rejecting files they do not own.
export async function attachmentsFor(userId, fileIds = [], purposes) {
  if (!fileIds.length) return [];
  const files = await File.find({ _id: { $in: fileIds }, owner: userId }).lean();
  if (files.length !== new Set(fileIds.map(String)).size) throw badRequest('One or more files were not found');
  if (purposes && files.some((f) => !purposes.includes(f.purpose))) throw badRequest('File was uploaded for a different purpose');
  return files.map((f) => ({ file: f._id, url: f.url, name: f.originalName, mime: f.mime }));
}
