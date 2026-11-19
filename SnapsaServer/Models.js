import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY
// ─────────────────────────────────────────────────────────────────────────────
const identitySchema = new mongoose.Schema({
    commitment: { type: String, required: true, unique: true, index: true },
    deliveryQueue: [{
        messageId:        { type: String, required: true },
        encryptedPayload: { type: Buffer, required: true },
        expiresAt:        { type: Date,   required: true }
    }],
    pushTokenHash: { type: String, sparse: true },

    isActive:  { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
}, { timestamps: false, collection: 'identities' });

identitySchema.index({ 'deliveryQueue.expiresAt': 1 }, { expireAfterSeconds: 0 });
identitySchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 * 30 });

// ─────────────────────────────────────────────────────────────────────────────
// CHALLENGE
// ─────────────────────────────────────────────────────────────────────────────
const challengeSchema = new mongoose.Schema({
    challenge:      { type: String, required: true, unique: true, index: true },
    commitmentHash: { type: String, required: true, index: true },
    used:      { type: Boolean, default: false },
    expiresAt: { type: Date, required: true }
}, { timestamps: false });

challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
challengeSchema.index({ commitmentHash: 1, used: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// NULLIFIER SET
// ─────────────────────────────────────────────────────────────────────────────
const nullifierSchema = new mongoose.Schema({
    nullifier: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true }
}, { timestamps: false });

nullifierSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// ANOMALY LOGS
// ─────────────────────────────────────────────────────────────────────────────
const AnomalyLogSchema = new mongoose.Schema({
    commitmentHash: { type: String, index: true },
    type:           { type: String, required: true },
    severity:       { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    details:        mongoose.Schema.Types.Mixed,
    resolved:       { type: Boolean, default: false },
    resolvedAt:     { type: Date },
    expiresAt:      { type: Date, required: true }
}, { timestamps: false });

AnomalyLogSchema.index({ commitmentHash: 1, expiresAt: -1 });
AnomalyLogSchema.index({ severity: 1, resolved: 1 });
AnomalyLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// SOCIAL GRAPH: follow requests
// ─────────────────────────────────────────────────────────────────────────────
const followRequestSchema = new mongoose.Schema({
    fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    toUserId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status:     { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' }
}, { timestamps: true });

followRequestSchema.index({ fromUserId: 1, toUserId: 1 }, { unique: true });
followRequestSchema.index({ fromUserId: 1, status: 1, createdAt: -1 });
followRequestSchema.index({ toUserId: 1, status: 1, createdAt: -1 });

// ─────────────────────────────────────────────────────────────────────────────
// SOCIAL GRAPH: followers
// ─────────────────────────────────────────────────────────────────────────────
const followerSchema = new mongoose.Schema({
    followerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    followingId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

followerSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
followerSchema.index({ followerId: 1, createdAt: -1 });
followerSchema.index({ followingId: 1, createdAt: -1 });

// ─────────────────────────────────────────────────────────────────────────────
// USER
// ─────────────────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
    zkCommitment:        { type: String, required: true, unique: true },
    encryptedIdentity:   { type: String, required: true },
    identityIv:          { type: String, required: true },
    identitySalt:        { type: String, required: true },
    setupProof:          { type: String, required: true },
    circuitVersion:      { type: String, required: true },
    displayNameEncrypted:{ type: String },
    displayNameIv:       { type: String },
    avatarEncrypted:     { type: String },
    avatarIv:            { type: String },
    coverEncrypted:      { type: String },
    coverIv:             { type: String },
    isOnline:            { type: Boolean, default: false },
    lastSeen:            { type: Date, default: Date.now },
    customStatus:        { type: String, default: '' },
    ghostMode:           { type: Boolean, default: false },
    isAdmin:             { type: Boolean, default: false },
    founder:             { type: Boolean, default: false },
    tier: { type: String, enum: [null, '', 'premium'], default: null },
    tierExpiresAt:       { type: Date, default: null },
    rank: {
        type: String,
        enum: ['Private', 'Corporal', 'Sergeant', 'Lieutenant', 'Captain', 'Major', 'Colonel', 'General'],
        default: 'Private'
    },
    clearanceLevel:  { type: Number, min: 1, max: 5, default: 1 },
    unit:            { type: String, default: '' },
    followerCount:   { type: Number, default: 0 },
    followingCount:  { type: Number, default: 0 },
    privacySettings: {
        identityVisibility: { type: String, enum: ['public', 'private'], default: 'public' },
        lastSeenVisibility: { type: String, enum: ['public', 'connections', 'private'], default: 'public' }
    },
    defcon: {
        level:     { type: Number, min: 1, max: 5, default: 5 },
        appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        appliedAt: { type: Date, default: Date.now },
        mode:      { type: String, enum: ['burn', null], default: null },
        lastAction:  String
    },
    encryptionKeys:    { current: mongoose.Schema.Types.Mixed, history: [mongoose.Schema.Types.Mixed] },
    coins:             { type: Number, default: 0 },
    earnings:          { type: Number, default: 0 },
    reservedBalance:   { type: Number, default: 0 },
    giftInventory:     { crowns: Number, diamonds: Number, flowers: Number, rockets: Number },
    anomalyScore:      { type: Number, default: 0 },
    lastSecurityCheck: Date,
    trustedDevices:    [String],
    lastFullSync:      Date,
    hasPendingActions: { type: Boolean, default: false }
}, { timestamps: true });

userSchema.index({ createdAt: -1 });
userSchema.index({ isOnline: -1, lastSeen: -1 });
userSchema.index({ followerCount: -1 });
userSchema.index({ rank: 1, clearanceLevel: -1 });
userSchema.index({ 'defcon.level': 1, updatedAt: -1 });
userSchema.index({ ghostMode: 1, isOnline: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────────────────────────────────────
const messageSchema = new mongoose.Schema({
    senderId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    receiverId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    groupId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
    text:         { type: String, trim: true, maxlength: 2000 },
    image:        String,
    imagePublicId:String,
    chatId:       { type: String, required: true },
    read:         { type: Boolean, default: false },
    readAt:       Date
}, { timestamps: false });

messageSchema.index({ chatId: 1, createdAt: -1 });
messageSchema.index({ senderId: 1, createdAt: -1 });
messageSchema.index({ receiverId: 1, read: 1, createdAt: -1 });
messageSchema.index({ groupId: 1, createdAt: -1 });

// ─────────────────────────────────────────────────────────────────────────────
// CHAT METADATA
// ─────────────────────────────────────────────────────────────────────────────
const userChatSchema = new mongoose.Schema({
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    chatId:      { type: String, required: true },
    partnerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    groupId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
    partnerType: { type: String, enum: ['user', 'group'], required: true },
    unreadCount: { type: Number, default: 0 },
    pinned:      { type: Boolean, default: false },
    muted:       { type: Boolean, default: false },
    archived:    { type: Boolean, default: false },
    lastReadAt:  Date
}, { timestamps: false });

userChatSchema.index({ userId: 1, updatedAt: -1 });
userChatSchema.index({ userId: 1, pinned: -1, updatedAt: -1 });
userChatSchema.index({ userId: 1, chatId: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────────
// GROUPS
// ─────────────────────────────────────────────────────────────────────────────
const groupSchema = new mongoose.Schema({
    name:        { type: String, required: true },
    description: String,
    avatar:      { type: String, default: '' },
    admin:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    settings: {
        isPrivate:    { type: Boolean, default: false },
        allowInvites: { type: Boolean, default: true }
    },
    memberCount: { type: Number, default: 1 }
}, { timestamps: true });

groupSchema.index({ admin: 1, createdAt: -1 });
groupSchema.index({ 'settings.isPrivate': 1, createdAt: -1 });
groupSchema.index({ memberCount: -1 });

const groupMemberSchema = new mongoose.Schema({
    groupId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role:     { type: String, enum: ['admin', 'member'], default: 'member' },
    joinedAt: { type: Date, default: Date.now }
}, { timestamps: true });

groupMemberSchema.index({ groupId: 1, userId: 1 }, { unique: true });
groupMemberSchema.index({ userId: 1, joinedAt: -1 });
groupMemberSchema.index({ groupId: 1, role: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// POSTS
// ─────────────────────────────────────────────────────────────────────────────
const postSchema = new mongoose.Schema({
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorSnapshot: {
        fullName: String,
        identityPic: String,
        verified: Boolean,
        badge: String,
        tier: { type: String, default: null }
    },
    content: { type: String, default: '', maxlength: 5000 },
    image: String,
    imagePublicId: String,
    video: String,
    videoPublicId: String,
    location: String,
    feeling: String,
    mood: String,
    energy: { type: Number, min: 1, max: 5 },
    burnAt: { type: Date, default: null },
    likeCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    shareCount: { type: Number, default: 0 },
    viewCount: { type: Number, default: 0 },
    trendingScore: { type: Number, default: 0 },
    recentEngagement: { type: Number, default: 0 },
    lastTrendingCalculation: { type: Date, default: Date.now },
    contentHash: { type: String, default: null },
    zkVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null }
}, { timestamps: false });

// ─────────────────────────────────────────────────────────────────────────────
// LIKES / COMMENTS / SHARES
// ─────────────────────────────────────────────────────────────────────────────
const likeSchema = new mongoose.Schema({
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

likeSchema.index({ postId: 1, userId: 1 }, { unique: true });
likeSchema.index({ userId: 1, createdAt: -1 });
likeSchema.index({ postId: 1, createdAt: -1 });

const commentSchema = new mongoose.Schema({
    postId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content:  { type: String, required: true, maxlength: 2000 },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
    likeCount:{ type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    deletedAt:{ type: Date, default: null }
}, { timestamps: true });

commentSchema.index({ postId: 1, createdAt: -1 });
commentSchema.index({ userId: 1, createdAt: -1 });
commentSchema.index({ postId: 1, parentId: 1, createdAt: -1 });

const shareSchema = new mongoose.Schema({
    postId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    shareType: { type: String, enum: ['repost', 'quote', 'external'], default: 'repost' }
}, { timestamps: true });

shareSchema.index({ postId: 1, userId: 1 }, { unique: true });
shareSchema.index({ userId: 1, createdAt: -1 });

// ─────────────────────────────────────────────────────────────────────────────
// VIEWS
// ─────────────────────────────────────────────────────────────────────────────
const viewSchema = new mongoose.Schema({
    postId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    sessionId:    { type: String },
    viewDuration: { type: Number },
    expiresAt:    { type: Date, required: true }
}, { timestamps: false });

viewSchema.index({ postId: 1 });
viewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// STATUSES (stories)
// ─────────────────────────────────────────────────────────────────────────────
const statusSchema = new mongoose.Schema({
    userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: String, mediaUrl: String, mediaPublicId: String,
    type:         { type: String, enum: ['text', 'image', 'video'], default: 'text' },
    visibility:   { type: String, enum: ['public', 'followers', 'private'], default: 'public' },
    durationHours:{ type: Number, default: 24 },
    burnAfterView:{ type: Boolean, default: false },
    viewCount:    { type: Number, default: 0 },
    expiresAt:    { type: Date, required: true }
}, { timestamps: true });

statusSchema.index({ userId: 1, createdAt: -1 });
statusSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
statusSchema.index({ visibility: 1, createdAt: -1 });

// ─────────────────────────────────────────────────────────────────────────────
// STATUS VIEWS
// ─────────────────────────────────────────────────────────────────────────────
const statusViewSchema = new mongoose.Schema({
    statusId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Status', required: true },
    viewerHash: { type: String, required: true },
    viewedAt:   { type: Date, default: Date.now },
    expiresAt:  { type: Date, required: true }
}, { timestamps: false });

statusViewSchema.index({ statusId: 1, viewerHash: 1 }, { unique: true });
statusViewSchema.index({ statusId: 1, viewedAt: -1 });
statusViewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
const notificationSchema = new mongoose.Schema({
    recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: {
        type: String, required: true,
        enum: [
            'follow', 'follow_request', 'like', 'comment', 'message',
            'group_invite', 'status_view', 'security_alert',
            'coin_transaction', 'gift_received', 'wallet_alert',
            'post_trending', 'rank_up', 'tier_upgrade',
            'defcon_change', 'ghost_mode', 'story',
            'gift_sent', 'gift_failed', 'story_like', 'story_repost',
            'music_sale', 'watch_reward', 'product_tag', 'product_sold',
            'tv_subscription',
            'report_update', 'account_warning',
            // Snapsa Wallet
            'wallet_application', 'wallet_update'
        ]
    },
    title:     { type: String, required: true },
    body:      { type: String, default: '' },
    data:      { type: mongoose.Schema.Types.Mixed, default: {} },
    delivered: { type: Boolean, default: false },
    read:      { type: Boolean, default: false },
    priority:  { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    expiresAt: { type: Date, required: true }
}, { timestamps: true });

notificationSchema.index({ recipientId: 1, delivered: 1, priority: -1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// COIN TRANSACTIONS
// ─────────────────────────────────────────────────────────────────────────────
const coinTransactionSchema = new mongoose.Schema({
    userId:               { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type:                 { type: String, enum: ['purchase', 'spend', 'refund'], required: true },
    encryptedAmount:      { type: String, required: true },
    amountIv:             { type: String, required: true },
    cost:                 { type: Number, default: 0 },
    currency:             { type: String, default: 'USD' },
    status:               { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    stripePaymentIntentId:{ type: String },
    description:          { type: String },
    expiresAt:            { type: Date, required: true }
}, { timestamps: true });

coinTransactionSchema.index({ userId: 1, status: 1, createdAt: -1 });
coinTransactionSchema.index({ stripePaymentIntentId: 1 }, { unique: true, sparse: true });
coinTransactionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED GIFTS
// ─────────────────────────────────────────────────────────────────────────────
const scheduledGiftSchema = new mongoose.Schema({
    senderId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recipientId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount:       { type: Number, required: true, min: 1 },
    message:      { type: String, maxlength: 500 },
    scheduledFor: { type: Date, required: true },
    status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
        default: 'pending'
    },
    processedAt:   Date,
    failureReason: String,
    expiresAt:     { type: Date, required: true }
}, { timestamps: true });

scheduledGiftSchema.index({ scheduledFor: 1, status: 1 });
scheduledGiftSchema.index({ senderId: 1, scheduledFor: 1, status: 1 });
scheduledGiftSchema.index({ recipientId: 1, scheduledFor: 1, status: 1 });
scheduledGiftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// WALLET SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
const walletSettingsSchema = new mongoose.Schema({
    userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    encryptedSettings:{ type: String, required: true },
    settingsIv:       { type: String, required: true }
}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
// PENDING ACTIONS
// ─────────────────────────────────────────────────────────────────────────────
const pendingActionSchema = new mongoose.Schema({
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type:        { type: String, required: true },
    encryptedData:{ type: String },
    dataIv:      { type: String },
    queuedAt:    { type: Date, default: Date.now },
    retries:     { type: Number, default: 0 },
    lastError:   String,
    priority:    { type: Number, default: 0 },
    processedAt: Date,
    expiresAt:   { type: Date, required: true }
}, { timestamps: false });

pendingActionSchema.index({ userId: 1, priority: -1, queuedAt: 1 });
pendingActionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMIT
// ─────────────────────────────────────────────────────────────────────────────
const rateLimitSchema = new mongoose.Schema({
    blindedId:     { type: String, required: true, index: true },
    count:         { type: Number, default: 0 },
    windowExpires: { type: Date, required: true }
}, { timestamps: false });

rateLimitSchema.index({ blindedId: 1, windowExpires: 1 });
rateLimitSchema.index({ windowExpires: 1 }, { expireAfterSeconds: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────
const Models = {
    Identity:   mongoose.models.Identity   || mongoose.model('Identity',   identitySchema),
    Challenge:  mongoose.models.Challenge  || mongoose.model('Challenge',  challengeSchema),
    Nullifier:  mongoose.models.Nullifier  || mongoose.model('Nullifier',  nullifierSchema),
    AnomalyLog: mongoose.models.AnomalyLog || mongoose.model('AnomalyLog', AnomalyLogSchema),
    RateLimit:  mongoose.models.RateLimit  || mongoose.model('RateLimit',  rateLimitSchema),
    User:          mongoose.models.User          || mongoose.model('User',          userSchema),
    Follower:      mongoose.models.Follower      || mongoose.model('Follower',      followerSchema),
    FollowRequest: mongoose.models.FollowRequest || mongoose.model('FollowRequest', followRequestSchema),
    Message:     mongoose.models.Message     || mongoose.model('Message',     messageSchema),
    UserChat:    mongoose.models.UserChat    || mongoose.model('UserChat',    userChatSchema),
    Group:       mongoose.models.Group       || mongoose.model('Group',       groupSchema),
    GroupMember: mongoose.models.GroupMember || mongoose.model('GroupMember', groupMemberSchema),
    Post:    mongoose.models.Post    || mongoose.model('Post',    postSchema),
    Like:    mongoose.models.Like    || mongoose.model('Like',    likeSchema),
    Comment: mongoose.models.Comment || mongoose.model('Comment', commentSchema),
    Share:   mongoose.models.Share   || mongoose.model('Share',   shareSchema),
    Status:  mongoose.models.Status  || mongoose.model('Status',  statusSchema),
    View:           mongoose.models.View           || mongoose.model('View',           viewSchema),
    StatusView:     mongoose.models.StatusView     || mongoose.model('StatusView',     statusViewSchema),
    Notification:   mongoose.models.Notification   || mongoose.model('Notification',   notificationSchema),
    CoinTransaction:mongoose.models.CoinTransaction|| mongoose.model('CoinTransaction',coinTransactionSchema),
    ScheduledGift:  mongoose.models.ScheduledGift  || mongoose.model('ScheduledGift',  scheduledGiftSchema),
    WalletSettings: mongoose.models.WalletSettings || mongoose.model('WalletSettings', walletSettingsSchema),
    PendingAction:  mongoose.models.PendingAction  || mongoose.model('PendingAction',  pendingActionSchema),
};

export default Models;
