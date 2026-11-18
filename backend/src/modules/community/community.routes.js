import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can, requirePermission } from '../../common/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS } from '../../common/roles.js';
import { escapeRegex, objectId, pageQuery, partialShape, queryBool, validate } from '../../common/validate.js';
import { audit } from '../audit/audit.model.js';
import { attachmentsFor } from '../files/file.routes.js';
import { notify } from '../notifications/notify.js';
import { COMMUNITY_KINDS, Comment, Community, CommunityMember, Post, REACTION_TYPES, Reaction } from './community.model.js';

const router = Router();
router.use(authenticate);

const AUTHOR = { path: 'author', select: 'name avatarUrl' };
const COMMUNITY = { path: 'community', select: 'name kind slug' };
const isStaff = (user) => can(user, PERMISSIONS.CONTENT_MODERATE);

async function visiblePost(id) {
  const post = await Post.findOne({ _id: id, status: 'visible' });
  if (!post) throw notFound('Post');
  return post;
}

async function activeCommunity(id) {
  const community = await Community.findOne({ _id: id, status: 'active' }).lean();
  if (!community) throw notFound('Community');
  return community;
}

const joinedSet = async (userId, communityIds) =>
  new Set((await CommunityMember.find({ user: userId, community: { $in: communityIds } }).select('community').lean()).map((m) => String(m.community)));

// ---- Communities: by city, locality, breed, community-dog care, rescue and adoption ----

router.get(
  '/communities',
  validate({
    query: {
      ...pageQuery,
      kind: z.enum(COMMUNITY_KINDS).optional(),
      city: z.string().trim().max(80).optional(),
      q: z.string().trim().max(80).optional(),
      // Only the communities the caller has joined.
      mine: queryBool.optional(),
    },
  }),
  async (req, res) => {
    const { page, limit, kind, city, q, mine } = req.valid.query;
    const ids = mine ? (await CommunityMember.find({ user: req.user._id }).select('community').lean()).map((m) => m.community) : null;
    const filter = {
      status: 'active',
      ...(ids && { _id: { $in: ids } }),
      ...(kind && { kind }),
      // A city's communities, plus the ones that are not tied to a city (a breed, rescue).
      ...(city && { city: { $in: [new RegExp(`^${escapeRegex(city)}$`, 'i'), null] } }),
      ...(q && { name: new RegExp(escapeRegex(q), 'i') }),
    };
    const result = await paginate(Community, filter, { page, limit, sort: { sortOrder: 1, memberCount: -1, name: 1 }, select: '-createdBy' });
    const joined = ids ? new Set(ids.map(String)) : await joinedSet(req.user._id, result.items.map((c) => c._id));
    res.json({ ...result, items: result.items.map((c) => ({ ...c, joined: joined.has(String(c._id)) })) });
  },
);

router.get('/communities/:id', validate(), async (req, res) => {
  const community = await Community.findOne({ _id: req.valid.params.id, status: 'active' }).select('-createdBy').lean();
  if (!community) throw notFound('Community');
  res.json({ ...community, joined: Boolean(await CommunityMember.exists({ community: community._id, user: req.user._id })) });
});

router.post('/communities/:id/join', validate(), async (req, res) => {
  const community = await activeCommunity(req.valid.params.id);
  const result = await CommunityMember.updateOne({ community: community._id, user: req.user._id }, { $setOnInsert: { community: community._id, user: req.user._id } }, { upsert: true });
  if (result.upsertedCount) await Community.updateOne({ _id: community._id }, { $inc: { memberCount: 1 } });
  res.json({ joined: true, memberCount: community.memberCount + (result.upsertedCount ? 1 : 0) });
});

router.delete('/communities/:id/join', validate(), async (req, res) => {
  const result = await CommunityMember.deleteOne({ community: req.valid.params.id, user: req.user._id });
  if (result.deletedCount) await Community.updateOne({ _id: req.valid.params.id }, { $inc: { memberCount: -1 } });
  res.status(204).end();
});

// ---- Posts ----

router.get(
  '/posts',
  validate({
    query: {
      ...pageQuery,
      tag: z.string().max(40).optional(),
      author: objectId.optional(),
      communityDog: objectId.optional(),
      community: objectId.optional(),
      // joined: posts from the communities the caller has joined.
      feed: z.enum(['all', 'joined']).default('all'),
    },
  }),
  async (req, res) => {
    const { page, limit, tag, author, communityDog, community, feed } = req.valid.query;
    const joined = feed === 'joined' ? (await CommunityMember.find({ user: req.user._id }).select('community').lean()).map((m) => m.community) : null;
    const filter = {
      status: 'visible',
      ...(tag && { tags: tag.toLowerCase() }),
      ...(author && { author }),
      ...(communityDog && { communityDog }),
      ...(community ? { community } : joined && { community: { $in: joined } }),
    };
    const result = await paginate(Post, filter, { page, limit, populate: [AUTHOR, COMMUNITY], select: '-moderation' });

    const mine = await Reaction.find({ user: req.user._id, post: { $in: result.items.map((p) => p._id) } }).lean();
    const reacted = new Map(mine.map((r) => [String(r.post), r.type]));
    result.items = result.items.map((p) => ({ ...p, myReaction: reacted.get(String(p._id)) ?? null, mine: String(p.author?._id) === String(req.user._id) }));
    res.json(result);
  },
);

router.post(
  '/posts',
  validate({
    body: {
      text: z.string().trim().max(4000).optional(),
      imageFileIds: z.array(objectId).max(10).optional(),
      tags: z.array(z.string().trim().max(40)).max(10).optional(),
      petId: objectId.optional(),
      communityDogId: objectId.optional(),
      // Post in a community the caller has joined.
      communityId: objectId.optional(),
      city: z.string().max(80).optional(),
    },
  }),
  async (req, res) => {
    const { imageFileIds, petId, communityDogId, communityId, ...body } = req.valid.body;
    if (!body.text && !imageFileIds?.length) throw badRequest('A post needs text or at least one image');
    const community = communityId ? await activeCommunity(communityId) : null;
    if (community && !isStaff(req.user) && !(await CommunityMember.exists({ community: community._id, user: req.user._id }))) {
      throw forbidden('Join the community to post in it');
    }
    const post = await Post.create({
      ...body,
      city: body.city ?? community?.city,
      author: req.user._id,
      images: await attachmentsFor(req.user._id, imageFileIds, ['community', 'pet_photo']),
      pet: petId,
      communityDog: communityDogId,
      community: community?._id,
    });
    if (community) await Community.updateOne({ _id: community._id }, { $inc: { postCount: 1 } });
    res.status(201).json(post);
  },
);

router.get('/posts/:id', validate(), async (req, res) => {
  const post = await Post.findOne({ _id: req.valid.params.id, status: 'visible' }).select('-moderation').populate([AUTHOR, COMMUNITY]).lean();
  if (!post) throw notFound('Post');
  const mine = await Reaction.findOne({ post: post._id, user: req.user._id }).lean();
  res.json({ ...post, myReaction: mine?.type ?? null, mine: String(post.author?._id) === String(req.user._id) });
});

// Authors delete their own posts.
router.delete('/posts/:id', validate(), async (req, res) => {
  const post = await Post.findOneAndUpdate({ _id: req.valid.params.id, author: req.user._id, status: 'visible' }, { status: 'removed' });
  if (!post) throw notFound('Post');
  if (post.community) await Community.updateOne({ _id: post.community }, { $inc: { postCount: -1 } });
  res.status(204).end();
});

// Sets (or changes) the caller's reaction; DELETE removes it.
router.put('/posts/:id/reaction', validate({ body: { type: z.enum(REACTION_TYPES).default('like') } }), async (req, res) => {
  const post = await visiblePost(req.valid.params.id);
  const result = await Reaction.updateOne({ post: post._id, user: req.user._id }, { type: req.valid.body.type }, { upsert: true });
  if (result.upsertedCount) await Post.updateOne({ _id: post._id }, { $inc: { reactionCount: 1 } });
  res.json({ type: req.valid.body.type });
});

router.delete('/posts/:id/reaction', validate(), async (req, res) => {
  const result = await Reaction.deleteOne({ post: req.valid.params.id, user: req.user._id });
  if (result.deletedCount) await Post.updateOne({ _id: req.valid.params.id }, { $inc: { reactionCount: -1 } });
  res.status(204).end();
});

router.get('/posts/:id/comments', validate({ query: pageQuery }), async (req, res) => {
  const post = await visiblePost(req.valid.params.id);
  const { page, limit } = req.valid.query;
  res.json(await paginate(Comment, { post: post._id, status: 'visible' }, { page, limit, sort: { createdAt: 1 }, populate: AUTHOR, select: '-moderation' }));
});

router.post('/posts/:id/comments', validate({ body: { text: z.string().trim().min(1).max(1000) } }), async (req, res) => {
  const post = await visiblePost(req.valid.params.id);
  const comment = await Comment.create({ post: post._id, author: req.user._id, text: req.valid.body.text });
  await Post.updateOne({ _id: post._id }, { $inc: { commentCount: 1 } });
  if (String(post.author) !== String(req.user._id)) {
    await notify([post.author], { type: 'community.comment', title: 'New comment on your post', body: comment.text.slice(0, 100), data: { postId: String(post._id) } });
  }
  res.status(201).json(comment);
});

router.delete('/comments/:id', validate(), async (req, res) => {
  const comment = await Comment.findOneAndUpdate({ _id: req.valid.params.id, author: req.user._id, status: 'visible' }, { status: 'removed' });
  if (!comment) throw notFound('Comment');
  await Post.updateOne({ _id: comment.post }, { $inc: { commentCount: -1 } });
  res.status(204).end();
});

export default router;

// ---- Admin: setting up communities (mounted at /admin/communities) ----
// Posts and comments are moderated with the rest of user content under /admin/moderation.

export const adminCommunitiesRouter = Router();
adminCommunitiesRouter.use(requirePermission(PERMISSIONS.CONTENT_MODERATE));

const communityBody = {
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,60}$/, 'Use lowercase letters, digits and hyphens'),
  kind: z.enum(COMMUNITY_KINDS),
  description: z.string().trim().max(1000).optional(),
  city: z.string().trim().max(80).nullable().optional(),
  locality: z.string().trim().max(80).nullable().optional(),
  breed: z.string().trim().max(60).nullable().optional(),
  // An uploaded image (purpose "community" or "banner"); null removes the cover.
  coverFileId: objectId.nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
  sortOrder: z.number().int().optional(),
};

async function communityFields(userId, { coverFileId, ...body }) {
  if (coverFileId === undefined) return body;
  if (coverFileId === null) return { ...body, cover: null };
  const [cover] = await attachmentsFor(userId, [coverFileId], ['community', 'banner']);
  return { ...body, cover };
}

adminCommunitiesRouter.get('/', validate({ query: { ...pageQuery, status: z.enum(['active', 'archived']).optional(), kind: z.enum(COMMUNITY_KINDS).optional() } }), async (req, res) => {
  const { page, limit, status, kind } = req.valid.query;
  res.json(await paginate(Community, { ...(status && { status }), ...(kind && { kind }) }, { page, limit, sort: { status: 1, kind: 1, sortOrder: 1, name: 1 } }));
});

adminCommunitiesRouter.post('/', validate({ body: communityBody }), async (req, res) => {
  if (await Community.exists({ slug: req.valid.body.slug })) throw conflict('A community with this slug exists');
  const community = await Community.create({ ...(await communityFields(req.user._id, req.valid.body)), createdBy: req.user._id });
  await audit(req, 'community.create', { type: 'community', id: community._id }, { meta: { name: community.name, kind: community.kind } });
  res.status(201).json(community);
});

adminCommunitiesRouter.patch('/:id', validate({ body: partialShape(communityBody) }), async (req, res) => {
  const community = await Community.findById(req.valid.params.id);
  if (!community) throw notFound('Community');
  if (req.valid.body.slug && req.valid.body.slug !== community.slug && (await Community.exists({ slug: req.valid.body.slug }))) throw conflict('A community with this slug exists');
  community.set(await communityFields(req.user._id, req.valid.body));
  await community.save();
  await audit(req, 'community.update', { type: 'community', id: community._id }, { meta: { fields: Object.keys(req.valid.body) } });
  res.json(community);
});
