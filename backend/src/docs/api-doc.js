// Hand-written documentation for one route, read by the OpenAPI builder (openapi.js) alongside the
// zod schemas. Put it in the route's middleware list; it does nothing at request time.
//   summary, description
//   requestExample: an example JSON body
//   upload: { field, description, required } for a route that also takes multipart/form-data with a file
//   responses: { [status]: { description, example } or { description, examples: { key: { summary, value } } } }
export function apiDoc(doc) {
  const middleware = (_req, _res, next) => next();
  middleware.doc = doc;
  return middleware;
}
