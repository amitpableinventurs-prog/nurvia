export async function paginate(model, filter, { page = 1, limit = 20, sort = { createdAt: -1 }, populate, select } = {}) {
  let query = model.find(filter).sort(sort).skip((page - 1) * limit).limit(limit);
  if (populate) query = query.populate(populate);
  if (select) query = query.select(select);
  const [items, total] = await Promise.all([query.lean(), model.countDocuments(filter)]);
  return { items, page, limit, total, pages: Math.ceil(total / limit) };
}
