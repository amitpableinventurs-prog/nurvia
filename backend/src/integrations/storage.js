import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

// Local-disk storage for development. Production should swap this for an object store
// (S3, GCS, Cloudflare R2...) behind the same three functions; public files would then be
// served from the bucket/CDN and private files through signed URLs.
const root = path.resolve(env.uploads.dir);
export const publicDir = path.join(root, 'public');
const privateDir = path.join(root, 'private');

const dirFor = (visibility) => (visibility === 'public' ? publicDir : privateDir);

export async function putObject(visibility, key, buffer) {
  const target = path.join(dirFor(visibility), key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer, { flag: 'wx' });
}

export const publicUrl = (key) => `${env.publicBaseUrl}/media/${key}`;

export const privatePath = (key) => path.join(privateDir, key);

export async function deleteObject(visibility, key) {
  await fs.rm(path.join(dirFor(visibility), key), { force: true });
}
