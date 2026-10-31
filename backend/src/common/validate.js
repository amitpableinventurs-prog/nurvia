import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

// An Indian mobile number, stored as +91XXXXXXXXXX. Accepts +91XXXXXXXXXX, 91XXXXXXXXXX or the
// 10-digit number typed next to a +91 picker, with spaces, dashes or brackets.
export const indianMobile = z
  .string()
  .transform((s) => s.replace(/[\s()-]/g, '').replace(/^(?:91)?([6-9]\d{9})$/, '+91$1'))
  .pipe(z.string().regex(/^\+91[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'));

export const geoQuery = {
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().positive().max(100).default(10),
};

export const point = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .transform(({ lat, lng }) => ({ type: 'Point', coordinates: [lng, lat] }));

// z.coerce.boolean() turns the string "false" into true, so query flags are parsed explicitly.
export const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

// Every field of a body shape made optional, for PATCH endpoints.
export const partialShape = (shape) => Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()]));

const idParams = z.object({ id: objectId }).passthrough();

// Parses the given parts of the request and exposes the results on req.valid.
// Express 5 makes req.query read-only, so parsed values are never written back onto req.
export function validate({ body, query, params } = {}) {
  const middleware = (req, _res, next) => {
    req.valid = {
      body: body ? z.object(body).strict().parse(req.body ?? {}) : undefined,
      query: query ? z.object(query).parse(req.query) : undefined,
      params: (req.params.id ? idParams.extend(params ?? {}) : z.object(params ?? {}).passthrough()).parse(req.params),
    };
    next();
  };
  // Read by the OpenAPI generator (src/docs/openapi.js).
  return Object.assign(middleware, { schemas: { body, query, params } });
}

export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
