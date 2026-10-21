export type AssetSymbol = 'NGN' | 'USDC' | 'USDT' | 'ETH' | 'SOL';
export type TxStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface PublicUser {
  id: string; username: string; displayName: string; avatar: string | null; avatarColor: string; verified: boolean;
  followers?: number; isFollowing?: boolean; isMe?: boolean;
}

export interface Me extends PublicUser {
  email: string; bio: string | null; createdAt: string; location: string | null; website: string | null;
  settings: Record<string, boolean>; followers: number; following: number; posts: number;
  walletActivated: boolean; unreadNotifications: number; unreadMessages: number;
  coverImage?: string | null; walletSecurity?: Record<string, boolean>;
}

export interface Poll { options: { id: string; label: string; votes: number }[]; total: number; myVote: string | null }

export interface Post {
  id: string; text: string; mediaUrls: string[]; mediaType: 'IMAGE' | 'VIDEO' | null; replyPolicy: string; createdAt: string;
  author: PublicUser; likeCount: number; commentCount: number; repostCount: number; giftCount: number; superLikeCount: number;
  earnedNgn: string; boosted: boolean; liked: boolean; superLiked: boolean; reposted: boolean; bookmarked: boolean; gifted: boolean; isMine: boolean;
  editedAt?: string | null; poll?: Poll | null;
}

export interface Comment { id: string; text: string; createdAt: string; parentId: string | null; author: PublicUser; replies: Comment[] }

export interface Profile extends PublicUser {
  bio: string | null; createdAt: string; location: string | null; website: string | null; coverImage: string | null;
  stats: { posts: number; followers: number; following: number; giftsReceived: number };
  isFollowing: boolean; followsYou: boolean; isMe: boolean;
}

export interface Notification {
  id: string; type: 'FOLLOW' | 'LIKE' | 'COMMENT' | 'REPOST' | 'MESSAGE' | 'GIFT_RECEIVED' | 'WITHDRAWAL_COMPLETED' | 'TRANSACTION_COMPLETED';
  title: string; body: string; amountLabel: string | null; postId: string | null; read: boolean; createdAt: string; actor: PublicUser | null;
}

export interface Conversation {
  id: string; user: PublicUser; unread: number; updatedAt: string;
  lastMessage: { text: string; kind: string; createdAt: string; mine: boolean } | null;
}
export interface Message { id: string; text: string; kind: string; meta?: Record<string, string> | null; attachment?: string | null; createdAt: string; mine: boolean; read: boolean }

/** Real Naira wallet (ledger-backed; changes only through verified provider events or atomic DB functions). */
export interface NgnWallet { balance: string; earnings: string; held: string }
/** Provider-managed (Coinbase CDP) crypto accounts — public addresses only. */
export interface CryptoWalletInfo {
  status: 'provisioning' | 'ready' | 'failed'; networkMode: 'testnet' | 'mainnet';
  evmAddress: string | null; solanaAddress: string | null; lastError: string | null;
}
export interface WalletLimits { depositMin: number; depositMax: number; withdrawMin: number; withdrawFee: number; withdrawDailyMax: number; transferMax: number }
export interface Wallet { ngn: NgnWallet; limits: WalletLimits; crypto: CryptoWalletInfo | null; cryptoActivated: boolean }

export interface ServerConfig {
  server: boolean;
  payments: { enabled: boolean; provider: 'paystack'; mode: 'live' | 'test' | 'off' };
  crypto: {
    enabled: boolean; provider: 'coinbase-cdp'; custody: 'provider-managed'; mode: 'testnet' | 'mainnet';
    networks: { id: 'ethereum' | 'base' | 'solana'; label: string; testnet: boolean; color: string; assets: string[] }[];
  };
  unavailable: Record<'swap' | 'buy' | 'sell', string>;
}

export interface ChainAssetBalance { symbol: string; decimals: number; balance: string | null; priceNgn: number | null; valueNgn: number | null }
export interface ChainBalances {
  mode: 'testnet' | 'mainnet'; fetchedAt: string;
  networks: { id: string; label: string; testnet: boolean; color: string; address: string; explorerAddress: string; assets: ChainAssetBalance[] }[];
}

export interface CryptoSend {
  id: string; status: 'submitting' | 'submitted' | 'confirmed' | 'failed' | 'dropped';
  txHash: string | null; explorerUrl: string | null; error: string | null;
  network?: string; asset?: string; amount?: string; to?: string; createdAt?: string; confirmedAt?: string | null;
}

export interface WalletTx {
  id: string; type: string; direction: 'IN' | 'OUT'; asset: string; amount: string; amountLabel: string; valueNgn: string | null; valueLabel: string | null;
  fee: string; feeLabel: string | null; status: TxStatus | 'SUCCESS' | 'PENDING' | 'REVERSED' | 'ABANDONED' | 'DROPPED'; reference: string; network: string | null; counterparty: string | null;
  description: string; simulated: false; txHash: string | null; explorerUrl: string | null; createdAt: string; completedAt: string | null;
}

export interface GiftQuote {
  amountNgn: string; payAsset: 'NGN'; rateNgn: string; payAmount: string; payLabel: string;
  creatorAmountNgn: string; platformFeeNgn: string; balance: string; balanceLabel: string; sufficient: boolean;
}

export interface LiveSession {
  id: string; title: string; status: 'live' | 'ended'; startedAt: string; endedAt: string | null; host: PublicUser;
  viewers: number; viewerPeak: number; giftTotal: string; isHost: boolean;
}
export interface LiveMessage { id: string; kind: 'TEXT' | 'GIFT'; body: string; createdAt: string; user: PublicUser; giftAmount: string | null }
export interface LiveView extends LiveSession { viewerList: PublicUser[]; messages: LiveMessage[] }

export interface Earnings {
  availableNgn: string; totalEarnedNgn: string; thisMonthNgn: string; monthDelta: string; totalGifts: number; supporters: number;
  byAsset: { asset: AssetSymbol; count: number; paidLabel: string; creatorNgn: string }[];
  history: { id: string; createdAt: string; amountNgn: string; amountLabel: string; giftLabel: string; sourceAsset: string; paidLabel: string; from: PublicUser; post: { id: string; text: string } | null; reference: string }[];
  withdrawals: { id: string; method: string; asset: string; amountLabel: string; valueLabel: string; status: TxStatus; reference: string; createdAt: string }[];
}

export interface GiftRecord {
  id: string; reference: string; createdAt: string; amountNgn: string; valueLabel: string; payAsset: string; payLabel: string;
  creatorLabel: string; platformFeeLabel: string; sender: PublicUser; recipient: PublicUser; post: { id: string; text: string } | null; status: string;
}
