import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../common/validate.js';
import { Category } from './category.model.js';

const router = Router();

router.get('/', validate({ query: { kind: z.enum(['vendor', 'service', 'product']).optional() } }), async (req, res) => {
  const { kind } = req.valid.query;
  res.json(await Category.find({ active: true, ...(kind && { kind }) }).sort({ sortOrder: 1, name: 1 }).lean());
});

export default router;
