import { Router } from 'express';
import { ah } from '../utils/errors';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { authLimiter, financeLimiter } from '../middleware/rateLimit';
import { upload } from '../middleware/upload';
import * as auth from '../controllers/auth';
import * as users from '../controllers/users';
import * as posts from '../controllers/posts';
import * as social from '../controllers/social';
import * as msgs from '../controllers/messages';
import * as wallet from '../controllers/wallet';

export const api = Router();

api.get('/health', (_req, res) => res.json({ ok: true, service: 'kamkam-api', time: new Date().toISOString() }));

// ── Auth
api.post('/auth/register', authLimiter, ah(auth.register));
api.post('/auth/login', authLimiter, ah(auth.login));
api.post('/auth/logout', ah(auth.logout));
api.get('/auth/me', requireAuth, ah(auth.me));

// ── Users & follows
api.get('/users/suggested', optionalAuth, ah(users.suggested));
api.patch('/users/me', requireAuth, ah(users.updateMe));
api.get('/users/:id', optionalAuth, ah(users.getProfile));
api.get('/users/:id/posts', optionalAuth, ah(users.userPosts));
api.get('/users/:id/gifts', optionalAuth, ah(users.giftWall));
api.get('/users/:id/followers', optionalAuth, ah(users.followers));
api.get('/users/:id/following', optionalAuth, ah(users.following));
api.post('/users/:id/follow', requireAuth, ah(users.follow));
api.delete('/users/:id/follow', requireAuth, ah(users.unfollow));

// ── Posts
api.get('/posts', optionalAuth, ah(posts.listPosts));
api.post('/posts', requireAuth, ah(posts.createPost));
api.get('/posts/:id', optionalAuth, ah(posts.getPost));
api.delete('/posts/:id', requireAuth, ah(posts.deletePost));
api.post('/posts/:id/like', requireAuth, ah(posts.like));
api.delete('/posts/:id/like', requireAuth, ah(posts.unlike));
api.get('/posts/:id/comments', optionalAuth, ah(posts.listComments));
api.post('/posts/:id/comment', requireAuth, ah(posts.comment));
api.post('/posts/:id/repost', requireAuth, ah(posts.repost));
api.delete('/posts/:id/repost', requireAuth, ah(posts.unrepost));
api.post('/posts/:id/bookmark', requireAuth, ah(posts.bookmark));
api.delete('/posts/:id/bookmark', requireAuth, ah(posts.unbookmark));
api.get('/bookmarks', requireAuth, ah(posts.listBookmarks));

// ── Uploads (images / video)
api.post('/uploads', requireAuth, upload.array('files', 4), ah(social.uploadFiles));

// ── Discovery
api.get('/search', optionalAuth, ah(social.search));
api.get('/trending', optionalAuth, ah(social.trending));

// ── Notifications
api.get('/notifications', requireAuth, ah(social.listNotifications));
api.post('/notifications/read', requireAuth, ah(social.markNotificationsRead));

// ── Messages
api.get('/conversations', requireAuth, ah(msgs.listConversations));
api.post('/conversations', requireAuth, ah(msgs.createConversation));
api.get('/conversations/:id/messages', requireAuth, ah(msgs.getMessages));
api.post('/conversations/:id/messages', requireAuth, ah(msgs.sendMessage));
api.post('/conversations/:id/read', requireAuth, ah(msgs.markRead));

// ── Wallet
api.get('/rates', ah(wallet.rates));
api.get('/wallet', requireAuth, ah(wallet.getWallet));
api.post('/wallet/activate', requireAuth, ah(wallet.activate));
api.get('/wallet/transactions', requireAuth, ah(wallet.listTransactions));
api.get('/wallet/transactions/:reference', requireAuth, ah(wallet.getTransaction));
api.get('/wallet/receive', requireAuth, ah(wallet.receiveInfo));
api.post('/wallet/quote/:action', requireAuth, ah(wallet.quote));
api.post('/wallet/:action', requireAuth, financeLimiter, ah(wallet.run));

// ── Gifts & creator earnings
api.get('/gifts/config', ah(wallet.giftConfig));
api.post('/gifts/quote', requireAuth, ah(wallet.giftQuote));
api.post('/gifts', requireAuth, financeLimiter, ah(wallet.giftSend));
api.get('/gifts', requireAuth, ah(wallet.listGifts));
api.get('/earnings', requireAuth, ah(wallet.earnings));
