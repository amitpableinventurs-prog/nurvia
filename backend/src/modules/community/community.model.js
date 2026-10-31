import mongoose from 'mongoose';
import { attachmentSchema, moderationFields } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

export const REACTION_TYPES = ['like', 'love', 'care'];

const postSchema = new mongoose.Schema(
  {
    author: { type: ObjectId, ref: 'User', required: true },
    text: { type: String, maxlength: 4000 },
    images: [attachmentSchema],
    tags: [{ type: String, lowercase: true, maxlength: 40 }],
    pet: { type: ObjectId, ref: 'Pet' },
    communityDog: { type: ObjectId, ref: 'CommunityDog' },
    city: String,
    reactionCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    ...moderationFields,
  },
  { timestamps: true },
);
postSchema.plugin(tenantPlugin);
postSchema.index({ tenant: 1, status: 1, createdAt: -1 });
postSchema.index({ tenant: 1, author: 1, createdAt: -1 });

const commentSchema = new mongoose.Schema(
  {
    post: { type: ObjectId, ref: 'Post', required: true },
    author: { type: ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, maxlength: 1000 },
    ...moderationFields,
  },
  { timestamps: true },
);
commentSchema.plugin(tenantPlugin);
commentSchema.index({ tenant: 1, post: 1, createdAt: 1 });

const reactionSchema = new mongoose.Schema(
  {
    post: { type: ObjectId, ref: 'Post', required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    type: { type: String, enum: REACTION_TYPES, default: 'like' },
  },
  { timestamps: true },
);
reactionSchema.plugin(tenantPlugin);
reactionSchema.index({ tenant: 1, post: 1, user: 1 }, { unique: true });

export const Post = mongoose.model('Post', postSchema);
export const Comment = mongoose.model('Comment', commentSchema);
export const Reaction = mongoose.model('Reaction', reactionSchema);
