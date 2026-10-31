import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/auth.js';
import { badRequest, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { objectId, pageQuery, validate } from '../../common/validate.js';
import { attachmentsFor } from '../files/file.routes.js';
import { notify } from '../notifications/notify.js';
import { Comment, Post, REACTION_TYPES, Reaction } from './community.model.js';

const router = Router();
router.use(authenticate);

const AUTHOR = { path: 'author', select: 'name avatarUrl' };

async function visiblePost(id) {
  const post = await Post.findOne({ _id: id, status: 'visible' });
  if (!post) throw notFound('Post');
  return post;
}

router.get(
  '/posts',
  validate({ query: { ...pageQuery, tag: z.string().max(40).optional(), author: objectId.optional(), communityDog: objectId.optional() } }),
  async (req, res) => {
    const { page, limit, tag, author, communityDog } = req.valid.query;
    const filter = { status: 'visible', ...(tag && { tags: tag.toLowerCase() }), ...(author && { author }), ...(communityDog && { communityDog }) };
    const result = await paginate(Post, filter, { page, limit, populate: AUTHOR, select: '-moderation' });

    const mine = await Reaction.find({ user: req.user._id, post: { $in: result.items.map((p) => p._id) } }).lean();
    const reacted = new Map(mine.map((r) => [String(r.post), r.type]));
    result.items = result.items.map((p) => ({ ...p, myReaction: reacted.get(String(p._id)) ?? null }));
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
      city: z.string().max(80).optional(),
    },
  }),
  async (req, res) => {
    const { imageFileIds, petId, communityDogId, ...body } = req.valid.body;
    if (!body.text && !imageFileIds?.length) throw badRequest('A post needs text or at least one image');
    const post = await Post.create({
      ...body,
      author: req.user._id,
      images: await attachmentsFor(req.user._id, imageFileIds, ['community', 'pet_photo']),
      pet: petId,
      communityDog: communityDogId,
    });
    res.status(201).json(post);
  },
);

router.get('/posts/:id', validate(), async (req, res) => {
  const post = await Post.findOne({ _id: req.valid.params.id, status: 'visible' }).select('-moderation').populate(AUTHOR).lean();
  if (!post) throw notFound('Post');
  const mine = await Reaction.findOne({ post: post._id, user: req.user._id }).lean();
  res.json({ ...post, myReaction: mine?.type ?? null });
});

router.delete('/posts/:id', validate(), async (req, res) => {
  const result = await Post.updateOne({ _id: req.valid.params.id, author: req.user._id, status: 'visible' }, { status: 'removed' });
  if (!result.matchedCount) throw notFound('Post');
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
