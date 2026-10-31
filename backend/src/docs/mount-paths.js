// Express 5 does not keep the path a router or middleware was mounted at, so the OpenAPI generator
// could not rebuild full URLs. This records it on each layer as `mountPath`. It must run before any
// route module calls router.use(), which is why app.js imports it ahead of the modules.
import express from 'express';

const { use } = express.Router.prototype;

express.Router.prototype.use = function useWithMountPath(...args) {
  const before = this.stack.length;
  const result = use.apply(this, args);
  const mountPath = typeof args[0] === 'string' ? args[0] : '/';
  for (const layer of this.stack.slice(before)) layer.mountPath = mountPath;
  return result;
};
