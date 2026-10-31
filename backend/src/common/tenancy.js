import { AsyncLocalStorage } from 'node:async_hooks';

// Every tenant-owned collection carries a `tenant` field. The current tenant is held in
// AsyncLocalStorage for the life of a request, and the plugin below scopes all queries to it,
// so a handler cannot read or write another tenant's data by forgetting a filter.
const storage = new AsyncLocalStorage();

export const runWithTenant = (tenant, fn) => storage.run({ tenant }, fn);
export const currentTenant = () => storage.getStore()?.tenant;

const QUERY_OPS = [
  'find',
  'findOne',
  'countDocuments',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'distinct',
];

export function tenantPlugin(schema) {
  schema.add({
    tenant: { type: String, required: true, index: true, immutable: true, default: currentTenant },
  });

  schema.pre(QUERY_OPS, { document: false, query: true }, function scopeQuery() {
    const tenant = currentTenant();
    if (!tenant) throw new Error(`Tenant context missing for ${this.model.modelName}.${this.op}`);
    this.where({ tenant });
  });

  schema.pre('aggregate', function scopeAggregate() {
    const tenant = currentTenant();
    if (!tenant) throw new Error(`Tenant context missing for ${this._model?.modelName}.aggregate`);
    const pipeline = this.pipeline();
    // $geoNear must stay the first stage, so the tenant match goes into its query instead.
    if (pipeline[0]?.$geoNear) {
      pipeline[0].$geoNear.query = { ...pipeline[0].$geoNear.query, tenant };
    } else {
      pipeline.unshift({ $match: { tenant } });
    }
  });

  schema.pre('insertMany', function scopeInsert(next, docs) {
    const tenant = currentTenant();
    for (const doc of docs) {
      if (doc.tenant && doc.tenant !== tenant) return next(new Error('Cross-tenant insert rejected'));
      doc.tenant = tenant;
    }
    next();
  });
}
