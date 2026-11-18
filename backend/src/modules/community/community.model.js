import mongoose from 'mongoose';
import { attachmentSchema, moderationFields } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

export const REACTION_TYPES = ['like', 'love', 'care'];

// Communities people join and post in. Staff set them up (admin panel); members join and leave.
export const COMMUNITY_KINDS = ['city', 'locality', 'breed', 'community_dogs', 'rescue', 'adoption'];

const communitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, lowercase: true, match: /^[a-z0-9-]{2,60}$/ },
    kind: { type: String, enum: COMMUNITY_KINDS, required: true },
    description: { type: String, maxlength: 1000 },
    city: { type: String, trim: true, maxlength: 80 },
    locality: { type: String, trim: true, maxlength: 80 },
    breed: { type: String, trim: true, maxlength: 60 },
    cover: attachmentSchema,
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    memberCount: { type: Number, default: 0 },
    postCount: { type: Number, default: 0 },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
communitySchema.plugin(tenantPlugin);
communitySchema.index({ tenant: 1, slug: 1 }, { unique: true });
communitySchema.index({ tenant: 1, status: 1, kind: 1, city: 1, sortOrder: 1 });

const memberSchema = new mongoose.Schema(
  {
    community: { type: ObjectId, ref: 'Community', required: true },
    user: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
memberSchema.plugin(tenantPlugin);
memberSchema.index({ tenant: 1, community: 1, user: 1 }, { unique: true });
memberSchema.index({ tenant: 1, user: 1, createdAt: -1 });

const postSchema = new mongoose.Schema(
  {
    author: { type: ObjectId, ref: 'User', required: true },
    text: { type: String, maxlength: 4000 },
    images: [attachmentSchema],
    tags: [{ type: String, lowercase: true, maxlength: 40 }],
    pet: { type: ObjectId, ref: 'Pet' },
    communityDog: { type: ObjectId, ref: 'CommunityDog' },
    // The community it was posted in; none for the general feed.
    community: { type: ObjectId, ref: 'Community' },
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
postSchema.index({ tenant: 1, community: 1, status: 1, createdAt: -1 });

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

export const Community = mongoose.model('Community', communitySchema);
export const CommunityMember = mongoose.model('CommunityMember', memberSchema);
export const Post = mongoose.model('Post', postSchema);
export const Comment = mongoose.model('Comment', commentSchema);
export const Reaction = mongoose.model('Reaction', reactionSchema);
