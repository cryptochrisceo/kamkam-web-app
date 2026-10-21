import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { badRequest } from '../utils/errors';

export const UPLOAD_DIR = path.resolve(__dirname, '../../uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

export const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + (ALLOWED[file.mimetype] || '')),
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 4 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED[file.mimetype]) cb(null, true);
    else cb(badRequest('Only JPG, PNG, WEBP, GIF images or MP4/WEBM/MOV videos are allowed.', 'UPLOAD'));
  },
});
