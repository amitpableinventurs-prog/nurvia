// Builds an OpenAPI 3 spec by walking the app's routers, so the docs always match the code:
// paths and methods come from the routes, request shapes from the zod schemas passed to validate(),
// and auth, roles, permissions and feature switches from the guards in front of each route. A route
// can add examples and responses with apiDoc() (api-doc.js).
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { authenticate, optionalAuth } from '../common/auth.js';

const API_PREFIX = '/api/v1';

const toJsonSchema = (shape) => {
  const { $schema, ...schema } = zodToJsonSchema(z.object(shape), { target: 'openApi3', $refStrategy: 'none', pipeStrategy: 'input' });
  return schema;
};

const joinPath = (...parts) => parts.join('').replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1') || '/';

// Express ":id" segments become OpenAPI "{id}".
const toOpenApiPath = (path) => path.replace(/:(\w+)/g, '{$1}');

// post /api/v1/auth/otp/request → postAuthOtpRequest; get /api/v1 itself → getApiV1, apart from get /.
// Without an operationId Swagger UI builds deep links with "_", which it warns about.
const operationIdFor = (method, path) =>
  [method, ...path.replace(`${API_PREFIX}/`, '/').split('/').filter(Boolean).map((s) => (s.startsWith(':') ? `by-${s.slice(1)}` : s))]
    .join('-')
    .replace(/[^a-zA-Z0-9]+(.)/g, (_m, c) => c.toUpperCase());

// A JSON schema read off an example value, so documented responses list their fields and types.
function schemaOf(value) {
  if (value === null) return { type: 'string', nullable: true };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? schemaOf(value[0]) : {} };
  if (typeof value === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, schemaOf(v)])) };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  return { type: typeof value };
}

// Form fields are flat, so a nested object is sent as name[key] fields; `upload` adds the file field.
function formSchema({ properties = {}, required = [] }, upload) {
  const fields = {};
  for (const [name, schema] of Object.entries(properties)) {
    if (schema.type === 'object' && schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) fields[`${name}[${key}]`] = sub;
    } else {
      fields[name] = schema;
    }
  }
  fields[upload.field] = { type: 'string', format: 'binary', description: upload.description };
  return { type: 'object', properties: fields, required: [...required, ...(upload.required ? [upload.field] : [])] };
}

function documentedResponse(status, { description, example, examples }) {
  const sample = example ?? Object.values(examples)[0].value;
  const schema = Number(status) >= 400 ? { $ref: '#/components/schemas/Error' } : schemaOf(sample);
  return { description, content: { 'application/json': { schema, ...(example !== undefined ? { example } : { examples }) } } };
}

function collectRoutes(router, prefix, context, routes) {
  let ctx = { ...context };
  for (const layer of router.stack) {
    const mountPath = layer.mountPath ?? '/';
    if (layer.route) {
      const path = joinPath(prefix, layer.route.path);
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        routes.push({ method, path, ctx, handles: layer.route.stack.map((l) => l.handle) });
      }
    } else if (Array.isArray(layer.handle?.stack)) {
      const tag = prefix === API_PREFIX ? mountPath.slice(1) : ctx.tag;
      collectRoutes(layer.handle, joinPath(prefix, mountPath), { ...ctx, tag }, routes);
    } else if (mountPath === '/') {
      // A guard mounted with router.use() covers every route registered after it in this router.
      ctx = applyGuard(ctx, layer.handle);
    } else {
      // A guard mounted on a sub-path (e.g. api.use('/adoption', requireFeature(...), router)) covers that sub-path only.
      const scoped = applyGuard({}, layer.handle);
      ctx = { ...ctx, scoped: [...(ctx.scoped ?? []), { path: joinPath(prefix, mountPath), guard: scoped }] };
    }
  }
  return routes;
}

function applyGuard(ctx, handle) {
  if (handle === authenticate) return { ...ctx, auth: 'required' };
  if (handle === optionalAuth) return { ...ctx, auth: ctx.auth ?? 'optional' };
  if (handle?.roles) return { ...ctx, auth: 'required', roles: handle.roles };
  if (handle?.permission) return { ...ctx, auth: 'required', permissions: [...(ctx.permissions ?? []), handle.permission] };
  if (handle?.feature) return { ...ctx, features: [...(ctx.features ?? []), handle.feature] };
  return ctx;
}

function buildOperation({ method, path, ctx, handles }) {
  let guards = { ...ctx };
  for (const { path: scopePath, guard } of ctx.scoped ?? []) {
    if (path === scopePath || path.startsWith(`${scopePath}/`)) {
      guards = { ...guards, ...guard, features: [...(guards.features ?? []), ...(guard.features ?? [])] };
    }
  }
  let schemas = {};
  let multipart = false;
  let doc = {};
  for (const handle of handles) {
    guards = applyGuard(guards, handle);
    if (handle.schemas) schemas = handle.schemas;
    if (handle.doc) doc = handle.doc;
    if (handle.name === 'multerMiddleware') multipart = true;
  }

  const tag = guards.tag || (path.startsWith(`${API_PREFIX}/`) ? path.split('/')[3] : 'system');
  const operation = { tags: [tag], operationId: operationIdFor(method, path), ...(doc.summary && { summary: doc.summary }), parameters: [], responses: {} };

  const paramSchema = schemas.params ? toJsonSchema(schemas.params).properties : {};
  for (const [, name] of path.matchAll(/:(\w+)/g)) {
    const schema = paramSchema[name] ?? (name === 'id' ? { type: 'string', pattern: '^[a-f\\d]{24}$' } : { type: 'string' });
    operation.parameters.push({ name, in: 'path', required: true, schema });
  }
  if (schemas.query) {
    const { properties = {}, required = [] } = toJsonSchema(schemas.query);
    for (const [name, schema] of Object.entries(properties)) {
      operation.parameters.push({ name, in: 'query', required: required.includes(name), schema });
    }
  }
  if (doc.upload) {
    // JSON, or a form that can also carry the file.
    const schema = toJsonSchema(schemas.body ?? {});
    operation.requestBody = {
      required: true,
      content: {
        'application/json': { schema, ...(doc.requestExample && { example: doc.requestExample }) },
        'multipart/form-data': { schema: formSchema(schema, doc.upload) },
      },
    };
  } else if (schemas.body || multipart) {
    const schema = schemas.body ? toJsonSchema(schemas.body) : { type: 'object', properties: {} };
    if (multipart) {
      schema.properties = { file: { type: 'string', format: 'binary' }, ...schema.properties };
      schema.required = ['file', ...(schema.required ?? [])];
    }
    const example = !multipart && doc.requestExample ? { example: doc.requestExample } : {};
    operation.requestBody = { required: true, content: { [multipart ? 'multipart/form-data' : 'application/json']: { schema, ...example } } };
  }

  const notes = doc.description ? [doc.description] : [];
  if (guards.roles) notes.push(`Roles: ${guards.roles.map((r) => `\`${r}\``).join(', ')}`);
  if (guards.permissions?.length) notes.push(`Permission: ${guards.permissions.map((p) => `\`${p}\``).join(', ')}`);
  if (guards.features?.length) notes.push(`Feature switch: ${guards.features.map((f) => `\`${f}\``).join(', ')} (403 FEATURE_DISABLED when off)`);
  if (guards.auth === 'optional') notes.push('Sign-in optional; some fields depend on the caller.');
  if (notes.length) operation.description = notes.join('\n\n');

  if (guards.auth === 'required') operation.security = [{ bearerAuth: [] }];
  if (guards.auth === 'optional') operation.security = [{}, { bearerAuth: [] }];

  for (const [status, response] of Object.entries(doc.responses ?? {})) operation.responses[status] = documentedResponse(status, response);
  const fallback = (status, applies, value) => applies && !operation.responses[status] && (operation.responses[status] = value);
  fallback('200', true, { description: 'Success' });
  fallback('400', schemas.body || schemas.query || schemas.params, { $ref: '#/components/responses/Error' });
  fallback('401', guards.auth === 'required', { $ref: '#/components/responses/Error' });
  fallback('403', guards.auth === 'required' || guards.features?.length, { $ref: '#/components/responses/Error' });
  return operation;
}

export function buildOpenApiSpec(app, { serverUrl } = {}) {
  const routes = collectRoutes(app.router, '', {}, []).filter((r) => !r.path.startsWith('/api-docs'));
  const paths = {};
  for (const route of routes) {
    const key = toOpenApiPath(route.path);
    paths[key] ??= {};
    paths[key][route.method] = buildOperation(route);
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Nurvia Petcare API',
      version: '1',
      description: [
        'Shared API for the Pet Parent app, Vendor app, Admin panel and Partner panel. Generated from the routes and their zod schemas.',
        '**Signing in:** staff use `POST /api/v1/auth/login` (dev: `admin@nurvia.local` / `nurvia-dev-password`). New pet parents and vendors send `{ "phone" }` to `POST /api/v1/auth/otp/request`, verify with `/auth/otp/verify` (`phone`, `code`), then submit the returned one-time `registrationToken` and profile to `/auth/register`. Existing phone accounts sign in by requesting and verifying a code. In development the code is returned as `devCode`. Copy `accessToken` from the response into **Authorize**. Tokens last 15 minutes.',
        '**Tenant:** requests use the default tenant unless an `X-Tenant: <slug>` header is sent.',
        'Errors always have the shape `{ "error": { "code", "message", "details?" } }`.',
      ].join('\n\n'),
    },
    servers: serverUrl ? [{ url: serverUrl }] : [],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'VALIDATION_FAILED' },
                message: { type: 'string', example: 'Request validation failed' },
                // Field errors for VALIDATION_FAILED; other errors may carry extra data such as { retryInSeconds }.
                details: {
                  oneOf: [
                    { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } } },
                    { type: 'object', additionalProperties: true },
                  ],
                  example: [{ path: 'phone', message: 'Enter a valid 10-digit Indian mobile number' }],
                },
              },
              required: ['code', 'message'],
            },
          },
          required: ['error'],
        },
      },
      responses: {
        Error: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
    paths,
  };
}
