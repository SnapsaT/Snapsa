import React, {
  useEffect, useRef, useState, useCallback, useMemo,
  createContext, useContext, useReducer
} from 'react';
import IVSBroadcastClient, {
  StreamType,
  Errors
} from 'amazon-ivs-web-broadcast';
import Hls from 'hls.js';
import { useTranslation } from "react-i18next";
import {
  X, Heart, Gift, MessageCircle, Share2, MoreVertical, Send,
  Mic, MicOff, Video, VideoOff, Monitor, Smile, Trophy, Star,
  Zap, Flame, Crown, Gem, Target, Timer, TrendingUp, Users,
  Lock, AlertCircle, ChevronUp, ChevronDown, Bolt, Flag,
  Music, Sparkles, ShoppingBag, Wallet, History,
  Shield, Settings, Info, CheckCircle2, XCircle,
  Bell, Calendar, Coffee, DollarSign, Gift as GiftIcon,
  MessageSquare, Pin, Radio, Shuffle, Swords, UserPlus,
  Volume2, Award, Coins, PartyPopper, Megaphone, Globe,
  Languages, Palmtree, Mountain, Waves, Snowflake, ArrowLeft, Play, Clock, Hash,
  Download, Trash2, Layers, ShoppingCart, Store, Banknote,
  Smartphone, CreditCard, BarChart3, PieChart, Activity,
  Badge, Medal, Crown as CrownIcon, Diamond, Package, Tag,
  Camera, Filter, Palette, Box, Percent, TrendingDown,
  RefreshCw, LogOut, User, Search, Menu, Filter as FilterIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================
const CONSTANTS = {
  LANGUAGES: [
    'English', 'Español', 'Français', 'Deutsch', 'Português',
    'العربية', '中文', '日本語', 'हिन्दी', 'Русский',
    'Afrikaans', 'isiZulu', 'isiXhosa', 'Setswana', 'Sesotho'
  ],
  CURRENCY: 'USD',
  CURRENCY_SYMBOL: '$',
  MAX_FILE_SIZE: 100 * 1024 * 1024,
  MAX_DAILY_SPEND: 500,
  MAX_GIFT_VELOCITY: 10,
  MIN_ACCOUNT_AGE_HOURS: 24,
  BREAK_REMINDER_MS: 900000,
  TAP_COMBO_WINDOW: 2000,
  CHAT_SCROLL_SPEED: 3000,
  LIKES_PER_GOAL_TIER: [100, 500, 1000, 5000, 10000, 500000, 1000000],
  TAP_COMPETITION: {
    ENABLED: true,
    MAX_TAPS_PER_SECOND: 10,
    COMBO_WINDOW: 2000,
    POWERUP_SPAWN_RATE: 0.1
  },
  COLORS: {
    primary: '#FF0050',
    secondary: '#00F5FF',
    gold: '#FFD700',
    purple: '#8B5CF6',
    dark: '#0F0F0F',
    light: '#FFFFFF'
  },
  DATA_SAVER_QUALITIES: ['240p', '360p', '480p', '720p', '1080p'],
  BATTLE_DURATION_MS: 180000, // 3 minutes
  PREDICTION_DURATION_SEC: 60,
  QUIZ_INTERVAL_MS: 20000
};

// ============================================================================
// SUBSCRIPTION TIERS WITH BRAND ADVERTISING
// ============================================================================
const SUBSCRIPTION_TIERS = [
  {
    id: 'bronze',
    name: 'Bronze',
    price: 4.99,
    icon: '🥉',
    color: '#CD7F32',
    adSlots: { daily: 1, weekly: 1 },
    arFilters: ['bronze_badge', 'basic_frame'],
    revenueShare: {
      gifts: 0.60,
      brandDeals: 0.40
    },
    benefits: [
      '100 daily coins',
      'Bronze badge',
      'Ad-free viewing',
      '📢 1 brand ad slot/day',
      '📢 1 premium brand slot/week'
    ]
  },
  {
    id: 'silver',
    name: 'Silver',
    price: 9.99,
    icon: '🥈',
    color: '#C0C0C0',
    adSlots: { daily: 3, weekly: 3 },
    arFilters: ['silver_badge', 'animated_frame', 'brand_logo_small'],
    revenueShare: {
      gifts: 0.65,
      brandDeals: 0.50
    },
    benefits: [
      '250 daily coins',
      'Silver badge',
      'Priority chat',
      '📢 3 brand ad slots/day',
      '📢 3 premium brand slots/week',
      'Small brand logo AR overlay'
    ]
  },
  {
    id: 'gold',
    name: 'Gold',
    price: 19.99,
    icon: '🥇',
    color: '#FFD700',
    adSlots: { daily: 5, weekly: 5 },
    arFilters: ['gold_badge', 'premium_frame', 'brand_wardrobe', 'virtual_try_on'],
    revenueShare: {
      gifts: 0.70,
      brandDeals: 0.60
    },
    benefits: [
      '600 daily coins',
      'Gold badge',
      'Exclusive gifts',
      'Name highlight',
      '📢 5 brand ad slots/day',
      '📢 5 premium brand slots/week',
      '🎽 Full AR brand wardrobe (hats, shirts, accessories)',
      '🛍️ In-stream product showcase'
    ]
  },
  {
    id: 'platinum',
    name: 'Platinum',
    price: 49.99,
    icon: '💎',
    color: '#E5E4E2',
    adSlots: { daily: Infinity, weekly: Infinity },
    arFilters: ['platinum_badge', 'custom_brand_ar', '3d_product_display', 'virtual_storefront'],
    revenueShare: {
      gifts: 0.75,
      brandDeals: 0.70
    },
    benefits: [
      '2000 daily coins',
      'Platinum badge',
      'Verified checkmark',
      '📢 Unlimited brand ad slots',
      '🏪 Virtual storefront in stream',
      '🎨 Custom AR filter creation',
      '💼 Exclusive brand partnerships',
      '📊 Advanced analytics dashboard',
    ]
  }
];

// ============================================================================
// BRAND PARTNERS DATABASE
// ============================================================================
const BRAND_PARTNERS = {
  'spar': {
    id: 'spar',
    name: 'SPAR',
    logo: '/brands/spar-logo.png',
    color: '#E31837',
    arAssets: {
      hat: '/ar/spar-hat.glb',
      shirt: '/ar/spar-shirt.glb',
      apron: '/ar/spar-apron.glb',
      background: '/ar/spar-store-bg.jpg'
    },
    products: [
      { id: 'spar_bread', name: 'SPAR Fresh Bread', price: 15.99, image: '/products/spar-bread.jpg' },
      { id: 'spar_milk', name: 'SPAR Milk 2L', price: 22.99, image: '/products/spar-milk.jpg' },
      { id: 'spar_braai', name: 'SPAR Braai Pack', price: 89.99, image: '/products/spar-braai.jpg' }
    ],
    payoutRate: 0.15,
    regions: ['ZA', 'NA', 'BW']
  },
  'pick_n_pay': {
    id: 'pick_n_pay',
    name: 'Pick n Pay',
    logo: '/brands/pnp-logo.png',
    color: '#0055A4',
    arAssets: {
      hat: '/ar/pnp-cap.glb',
      shirt: '/ar/pnp-polo.glb',
      vest: '/ar/pnp-vest.glb',
      trolley: '/ar/pnp-trolley.glb'
    },
    products: [
      { id: 'pnp_no_name', name: 'No Name Brand Beans', price: 12.99, image: '/products/pnp-beans.jpg' },
      { id: 'pnp_fresh', name: 'PnP Fresh Chicken', price: 45.99, image: '/products/pnp-chicken.jpg' }
    ],
    payoutRate: 0.12,
    regions: ['ZA']
  },
  'shoprite': {
    id: 'shoprite',
    name: 'Shoprite',
    logo: '/brands/shoprite-logo.png',
    color: '#D7141A',
    arAssets: {
      hat: '/ar/shoprite-visor.glb',
      shirt: '/ar/shoprite-tshirt.glb'
    },
    products: [
      { id: 'shoprite_usave', name: 'Usave Mixed Veg', price: 19.99, image: '/products/usave-veg.jpg' }
    ],
    payoutRate: 0.10,
    regions: ['ZA', 'NA', 'SZ']
  },
  'mtn': {
    id: 'mtn',
    name: 'MTN',
    logo: '/brands/mtn-logo.png',
    color: '#FFCC00',
    arAssets: {
      hat: '/ar/mtn-beanie.glb',
      shirt: '/ar/mtn-jersey.glb',
      phone: '/ar/mtn-phone.glb'
    },
    products: [
      { id: 'mtn_data_1gb', name: 'MTN 1GB Data Bundle', price: 49.00, digital: true },
      { id: 'mtn_airtime_100', name: 'MTN R100 Airtime', price: 100.00, digital: true }
    ],
    payoutRate: 0.08,
    regions: ['ZA', 'NG', 'GH', 'UG', 'RW']
  },
  'vodacom': {
    id: 'vodacom',
    name: 'Vodacom',
    logo: '/brands/vodacom-logo.png',
    color: '#E60000',
    arAssets: {
      hat: '/ar/vodacom-cap.glb',
      scarf: '/ar/vodacom-scarf.glb'
    },
    products: [
      { id: 'voda_data_2gb', name: 'Vodacom 2GB + WhatsApp', price: 79.00, digital: true }
    ],
    payoutRate: 0.08,
    regions: ['ZA', 'BW', 'TZ', 'MZ', 'CD']
  }
};

// ============================================================================
// GIFT SYSTEM - GLOBAL CULTURES
// ============================================================================
const GIFT_CATEGORIES = {
  BASIC: { id: 'basic', name: 'Basic', color: '#9CA3AF', icon: '✨' },
  PREMIUM: { id: 'premium', name: 'Premium', color: '#3B82F6', icon: '💎' },
  LEGENDARY: { id: 'legendary', name: 'Legendary', color: '#8B5CF6', icon: '👑' },
  CULTURAL: { id: 'cultural', name: 'Cultural', color: '#10B981', icon: '🌍' },
  EVENT: { id: 'event', name: 'Event', color: '#F59E0B', icon: '🎉' },
  MYSTERY: { id: 'mystery', name: 'Mystery', color: '#EC4899', icon: '❓' }
};

const GIFT_TYPES = [
  { id: 'clap', name: 'Clap', icon: '👏', cost: 1, category: 'basic', rarity: 'common', animation: 'bounce', weight: 1 },
  { id: 'heart', name: 'Love', icon: '❤️', cost: 5, category: 'basic', rarity: 'common', animation: 'float', weight: 1 },
  { id: 'star', name: 'Star', icon: '⭐', cost: 10, category: 'basic', rarity: 'common', animation: 'spin', weight: 1 },
  { id: 'rose', name: 'Rose', icon: '🌹', cost: 25, category: 'basic', rarity: 'common', animation: 'bloom', weight: 2 },
  { id: 'fire', name: 'Fire', icon: '🔥', cost: 50, category: 'premium', rarity: 'rare', animation: 'burst', weight: 5, fullscreen: true },
  { id: 'rocket', name: 'Rocket', icon: '🚀', cost: 100, category: 'premium', rarity: 'rare', animation: 'fly', weight: 10 },
  { id: 'crown', name: 'Crown', icon: '👑', cost: 250, category: 'premium', rarity: 'epic', animation: 'crown', weight: 20, screenLock: 3 },
  { id: 'unicorn', name: 'Unicorn', icon: '🦄', cost: 500, category: 'premium', rarity: 'epic', animation: 'gallop', weight: 30 },
  { id: 'diamond', name: 'Diamond Throne', icon: '💎', cost: 1000, category: 'legendary', rarity: 'legendary', animation: 'shatter', weight: 100, screenLock: 5, globalNotify: true },
  { id: 'dragon', name: 'Dragon', icon: '🐉', cost: 2500, category: 'legendary', rarity: 'mythic', animation: 'flyover', weight: 200, comboUnlock: true },
  { id: 'galaxy', name: 'Galaxy', icon: '🌌', cost: 5000, category: 'legendary', rarity: 'mythic', animation: 'cosmic', weight: 500, screenRumble: true },
  { id: 'african_drum', name: 'African Drum', icon: '🪘', cost: 30, category: 'cultural', rarity: 'rare', animation: 'beat', weight: 3, region: 'africa' },
  { id: 'elephant', name: 'Elephant', icon: '🐘', cost: 75, category: 'cultural', rarity: 'epic', animation: 'stampede', weight: 8, region: 'africa' },
  { id: 'lion', name: 'Lion', icon: '🦁', cost: 100, category: 'cultural', rarity: 'epic', animation: 'roar', weight: 10, region: 'africa' },
  { id: 'mystery_box', name: 'Mystery Box', icon: '🎁', cost: 50, category: 'mystery', rarity: 'special', animation: 'reveal', weight: 0, mystery: true, minValue: 25, maxValue: 500 }
];

// ============================================================================
// AR FILTER CATEGORIES
// ============================================================================
const AR_FILTER_CATEGORIES = {
  zk_exclusive: {
    id: 'zk_exclusive',
    name: 'ZK-Exclusive',
    icon: '🔐',
    color: '#8B5CF6',
    description: 'Privacy-first filters only you can use',
    filters: [
      { id: 'face_lock', name: 'Face Lock', icon: '🔐', cost: 0, requiresZK: true },
      { id: 'anon_mask', name: 'ZK-Anon', icon: '🎭', cost: 0, requiresZK: true },
      { id: 'deepfake_proof', name: 'Deepfake Shield', icon: '🛡️', cost: 0, requiresZK: true }
    ]
  },
  voice_activated: {
    id: 'voice_activated',
    name: 'Voice AR',
    icon: '🎤',
    color: '#EC4899',
    description: 'Say the magic words!',
    filters: [
      { id: 'voice_rainbow', name: 'Voice Rainbow', icon: '🌈', cost: 10, voiceTrigger: 'rainbow' },
      { id: 'spell_caster', name: 'Spell Caster', icon: '⚡', cost: 25, voiceTrigger: 'abracadabra' },
      { id: 'dragon_roar', name: 'Dragon Roar', icon: '🐉', cost: 50, voiceTrigger: 'roar' }
    ]
  },
  brand_wardrobe: {
    id: 'brand_wardrobe',
    name: 'Brand Wardrobe',
    icon: '👕',
    color: '#10B981',
    description: 'Wear brand merchandise virtually',
    filters: [
      { id: 'spar_hat', name: 'SPAR Hat', icon: '🧢', cost: 0, brand: 'spar', type: 'hat' },
      { id: 'spar_shirt', name: 'SPAR Shirt', icon: '👕', cost: 0, brand: 'spar', type: 'shirt' },
      { id: 'pnp_cap', name: 'PnP Cap', icon: '🧢', cost: 0, brand: 'pick_n_pay', type: 'hat' },
      { id: 'mtn_jersey', name: 'MTN Jersey', icon: '👕', cost: 0, brand: 'mtn', type: 'shirt' }
    ]
  },
  neural_art: {
    id: 'neural_art',
    name: 'Neural Art',
    icon: '🎨',
    color: '#10B981',
    description: 'AI-powered artistic styles',
    filters: [
      { id: 'van_gogh', name: 'Van Gogh', icon: '🌻', cost: 30, artist: 'Van Gogh' },
      { id: 'anime_style', name: 'Anime', icon: '⭐', cost: 20, style: 'anime' },
      { id: 'cyberpunk', name: 'Cyberpunk', icon: '🤖', cost: 40, style: 'cyberpunk' }
    ]
  },
  nft_filters: {
    id: 'nft_filters',
    name: 'NFT Collection',
    icon: '💎',
    color: '#F59E0B',
    description: 'Exclusive owned filters',
    filters: [
      { id: 'legendary_dragon', name: 'Legendary Dragon', icon: '🐲', cost: 500, rarity: 'legendary', nft: true },
      { id: 'cosmic_crown', name: 'Cosmic Crown', icon: '👑', cost: 250, rarity: 'epic', nft: true }
    ]
  }
};

const ALL_AR_FILTERS = Object.values(AR_FILTER_CATEGORIES).flatMap(cat =>
  cat.filters.map(f => ({ ...f, category: cat.id, categoryColor: cat.color }))
);

// ============================================================================
// PROGRESSION SYSTEM
// ============================================================================
const VIEWER_LEVELS = [
  { level: 1, name: 'Newbie', icon: '🌱', minXP: 0, reward: 'Basic chat', color: '#9CA3AF' },
  { level: 2, name: 'Regular', icon: '🌟', minXP: 100, reward: 'Custom emoji', color: '#60A5FA' },
  { level: 3, name: 'Engaged', icon: '💫', minXP: 500, reward: 'Name color', color: '#A78BFA' },
  { level: 4, name: 'Supporter', icon: '💎', minXP: 2000, reward: 'Priority chat', color: '#F59E0B' },
  { level: 5, name: 'VIP', icon: '👑', minXP: 10000, reward: 'Exclusive badge', color: '#EF4444' },
  { level: 6, name: 'Legend', icon: '🔥', minXP: 50000, reward: '20% gift discount', color: '#8B5CF6' },
  { level: 7, name: 'Mythic', icon: '⚡', minXP: 100000, reward: 'Custom animations', color: '#EC4899' }
];

const BADGES = {
  STREAK_7: { id: 'streak_7', name: 'Week Warrior', icon: '🔥', condition: '7 day streak', xp: 100 },
  STREAK_30: { id: 'streak_30', name: 'Month Master', icon: '🌟', condition: '30 day streak', xp: 500 },
  WHALE: { id: 'whale', name: 'Big Spender', icon: '🐋', condition: 'Spend $1000', xp: 1000 },
  SUPPORTER: { id: 'supporter', name: 'True Fan', icon: '💝', condition: 'Spend $100', xp: 200 },
  EARLY: { id: 'early', name: 'Early Bird', icon: '🐦', condition: 'Join first 100', xp: 50 },
  LOYAL: { id: 'loyal', name: 'Loyal Fan', icon: '💎', condition: 'Watch 100 hours', xp: 500 },
  FIRST_GIFT: { id: 'first_gift', name: 'Gift Giver', icon: '🎁', condition: 'Send first gift', xp: 10 },
  PK_CHAMPION: { id: 'pk_champ', name: 'PK Champion', icon: '⚔️', condition: 'Win 10 PKs', xp: 500 }
};

// ============================================================================
// BATTLE STATES
// ============================================================================
const BATTLE_STATES = {
  IDLE: 'idle',
  SEARCHING: 'searching',
  MATCHED: 'matched',
  COUNTDOWN: 'countdown',
  ACTIVE: 'active',
  ENDING: 'ending',
  FINISHED: 'finished'
};

// ============================================================================
// POLL TYPES
// ============================================================================
const POLL_TYPES = {
  SIMPLE: 'simple',
  PREDICTION: 'prediction',
  COIN_WEIGHTED: 'coin_weighted'
};

// ============================================================================
// TIP MENU
// ============================================================================
const TIP_MENU = [
  { id: 'coffee', name: 'Buy Coffee', icon: '☕', amount: 5, message: 'Thanks for the energy!' },
  { id: 'pizza', name: 'Buy Pizza', icon: '🍕', amount: 15, message: 'Pizza time!' },
  { id: 'request_song', name: 'Request Song', icon: '🎵', amount: 10, message: 'Play my song!' },
  { id: 'shoutout', name: 'Shoutout', icon: '📢', amount: 20, message: 'Shoutout please!' },
  { id: 'challenge', name: 'Challenge', icon: '🎯', amount: 25, message: 'Do this challenge!' },
  { id: 'custom', name: 'Custom Tip', icon: '💰', amount: 0, message: '' }
];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
const formatTime = (timestamp) => {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
};

const formatCurrency = (amount, currency = 'USD') => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
};

const formatNumber = (num) => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

const formatDuration = (ms) => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
};

const calculateLevel = (xp) => {
  for (let i = VIEWER_LEVELS.length - 1; i >= 0; i--) {
    if (xp >= VIEWER_LEVELS[i].minXP) return VIEWER_LEVELS[i];
  }
  return VIEWER_LEVELS[0];
};

const checkVelocity = (timestamps, limit, windowMs) => {
  const now = Date.now();
  const recent = timestamps.filter(t => now - t < windowMs);
  return recent.length <= limit;
};

const randomMysteryValue = (min, max) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

// ============================================================================
// INITIAL STATE
// ============================================================================
const initialState = {
  viewerXP: 0,
  streak: 0,
  coins: 500,
  dailySpend: 0,
  totalSpend: 0,
  subscription: null,
  badges: [],
  viewers: 0,
  peakViewers: 0,
  likes: 0,
  giftHistory: [],
  messages: [],
  activeGifts: [],
  leaderboard: [],
  goals: { current: 0, target: 5000, title: 'Stream Goal', rewards: [] },
  boosters: { active: false, multiplier: 1, expires: null },
  combo: { count: 0, lastGift: null, expires: null },
  questions: [],
  polls: [],
  activePoll: null,
  predictions: [],
  activePrediction: null,
  pinnedMessage: null,
  battleState: BATTLE_STATES.IDLE,
  battleOpponent: null,
  battleScore: { us: 0, them: 0 },
  battleTimer: 120,
  tapScore: 0,
  tapCombo: 0,
  tapLeaderboard: [],
  tapPowerups: [],
  scheduledStreams: [],
  upcomingEvents: [],
  safety: {
    warnings: 0,
    locked: false,
    sessionTime: 0,
    breakReminders: 0
  },
  analytics: {
    watchTime: 0,
    giftsReceived: 0,
    messagesReceived: 0,
    avgViewers: 0,
    peakTime: null
  },
  activeARFilters: [],
  showARGallery: false,
  viewerEarnings: 0,
  earningsPerSecond: 0.00012,
  totalWatchTime: 0.5,
  showEarningsModal: false,
  topLikers: [],
  blockedUsers: [],
  pinnedUser: null,
  pinnedTopic: null,
  showGiftStore: false,
  showEndStream: false,
  streamStartTime: Date.now(),
  sessionWatchTime: {},
  sessionLikes: {},
  totalRevenue: 0,
  // Brand Advertising
  activeBrand: null,
  brandMode: false,
  shoppingActive: false,
  adSlots: {
    usedToday: 0,
    usedThisWeek: 0,
    earnings: {
      today: 0,
      thisWeek: 0,
      thisMonth: 0,
      pendingPayout: 0
    }
  },
  // Data Saver
  dataSaverEnabled: false,
  videoQuality: 'auto',
  // Hype Train
  hypeTrain: {
    active: false,
    level: 1,
    progress: 0,
    contributors: []
  },
  // Quiz
  quizActive: false,
  quizQuestion: null,
  quizTimer: 0
};

// ============================================================================
// REDUCER
// ============================================================================
function liveStreamReducer(state, action) {
  switch (action.type) {
    case 'ADD_XP':
      return { ...state, viewerXP: state.viewerXP + action.payload };
    case 'UPDATE_COINS':
      return { ...state, coins: action.payload };
    case 'ADD_GIFT':
      return {
        ...state,
        giftHistory: [...state.giftHistory, action.payload],
        dailySpend: state.dailySpend + action.payload.cost,
        totalSpend: state.totalSpend + action.payload.cost,
        activeGifts: [...state.activeGifts, action.payload],
        totalRevenue: state.totalRevenue + action.payload.cost
      };
    case 'UPDATE_COMBO':
      return { ...state, combo: action.payload };
    case 'ACTIVATE_BOOSTER':
      return { ...state, boosters: { active: true, ...action.payload } };
    case 'ADD_MESSAGE': {
      const newMessages = [...state.messages.slice(-100), action.payload];
      return { ...state, messages: newMessages };
    }
    case 'REMOVE_MESSAGE':
      return { ...state, messages: state.messages.filter(m => m.id !== action.payload) };
    case 'PIN_MESSAGE':
      return { ...state, pinnedMessage: action.payload };
    case 'SET_LEADERBOARD':
      return { ...state, leaderboard: action.payload };
    case 'UPDATE_GOAL':
      return { ...state, goals: { ...state.goals, current: state.goals.current + action.payload } };
    case 'ADD_BADGE':
      if (state.badges.find(b => b.id === action.payload.id)) return state;
      return { ...state, badges: [...state.badges, action.payload] };
    case 'UPDATE_VIEWERS':
      return {
        ...state,
        viewers: action.payload,
        peakViewers: Math.max(state.peakViewers, action.payload)
      };
    case 'ADD_LIKE': {
      const userId = action.payload;
      return {
        ...state,
        likes: state.likes + 1,
        sessionLikes: {
          ...state.sessionLikes,
          [userId]: (state.sessionLikes[userId] || 0) + 1
        }
      };
    }
    case 'UPDATE_TAP_SCORE':
      return {
        ...state,
        tapScore: action.payload.score,
        tapCombo: action.payload.combo
      };
    case 'SET_BATTLE_STATE':
      return { ...state, battleState: action.payload };
    case 'UPDATE_BATTLE_SCORE':
      return { ...state, battleScore: action.payload };
    case 'ADD_POLL':
      return { ...state, polls: [...state.polls, action.payload] };
    case 'SET_ACTIVE_POLL':
      return { ...state, activePoll: action.payload };
    case 'ADD_PREDICTION':
      return { ...state, predictions: [...state.predictions, action.payload] };
    case 'SET_ACTIVE_PREDICTION':
      return { ...state, activePrediction: action.payload };
    case 'ADD_QUESTION':
      return { ...state, questions: [...state.questions, action.payload] };
    case 'SET_SUBSCRIPTION':
      return { ...state, subscription: action.payload };
    case 'SAFETY_WARNING':
      return { ...state, safety: { ...state.safety, warnings: state.safety.warnings + 1 } };
    case 'LOCK_ACCOUNT':
      return { ...state, safety: { ...state.safety, locked: true } };
    case 'UPDATE_SESSION_TIME':
      return { ...state, safety: { ...state.safety, sessionTime: action.payload } };
    case 'TOGGLE_AR_GALLERY':
      return { ...state, showARGallery: !state.showARGallery };
    case 'ADD_AR_FILTER':
      return { ...state, activeARFilters: [...state.activeARFilters, action.payload] };
    case 'REMOVE_AR_FILTER':
      return { ...state, activeARFilters: state.activeARFilters.filter(f => f.id !== action.payload) };
    case 'TOGGLE_EARNINGS':
      return { ...state, showEarningsModal: !state.showEarningsModal };
    case 'UPDATE_EARNINGS':
      return { ...state, viewerEarnings: action.payload };
    case 'REMOVE_GIFT':
      return { ...state, activeGifts: state.activeGifts.filter(g => g.id !== action.payload) };
    case 'UPDATE_TOP_LIKERS':
      return { ...state, topLikers: action.payload };
    case 'BLOCK_USER':
      return { ...state, blockedUsers: [...state.blockedUsers, action.payload] };
    case 'UNBLOCK_USER':
      return { ...state, blockedUsers: state.blockedUsers.filter(u => u !== action.payload) };
    case 'PIN_USER':
      return { ...state, pinnedUser: action.payload };
    case 'UNPIN_USER':
      return { ...state, pinnedUser: null };
    case 'PIN_TOPIC':
      return { ...state, pinnedTopic: action.payload };
    case 'UNPIN_TOPIC':
      return { ...state, pinnedTopic: null };
    case 'TOGGLE_GIFT_STORE':
      return { ...state, showGiftStore: !state.showGiftStore };
    case 'TOGGLE_END_STREAM':
      return { ...state, showEndStream: !state.showEndStream };
    case 'UPDATE_WATCH_TIME': {
      return {
        ...state,
        sessionWatchTime: {
          ...state.sessionWatchTime,
          [action.payload.userId]: (state.sessionWatchTime[action.payload.userId] || 0) + action.payload.time
        }
      };
    }
    // Brand Advertising
    case 'SET_ACTIVE_BRAND':
      return { ...state, activeBrand: action.payload };
    case 'SET_BRAND_MODE':
      return { ...state, brandMode: action.payload };
    case 'TOGGLE_SHOPPING':
      return { ...state, shoppingActive: !state.shoppingActive };
    case 'UPDATE_AD_SLOTS':
      return { ...state, adSlots: { ...state.adSlots, ...action.payload } };
    // Data Saver
    case 'TOGGLE_DATA_SAVER':
      return { ...state, dataSaverEnabled: action.payload };
    case 'SET_VIDEO_QUALITY':
      return { ...state, videoQuality: action.payload };
    // Hype Train
    case 'UPDATE_HYPE_TRAIN':
      return { ...state, hypeTrain: action.payload };
    // Quiz
    case 'SET_QUIZ_ACTIVE':
      return { ...state, quizActive: action.payload };
    case 'SET_QUIZ_QUESTION':
      return { ...state, quizQuestion: action.payload };
    case 'SET_QUIZ_TIMER':
      return { ...state, quizTimer: action.payload };
    default:
      return state;
  }
}

// ============================================================================
// ERROR BOUNDARY
// ============================================================================
export class LiveStreamErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('LiveStream Error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <h2 className="text-red-800 font-bold">Stream Error</h2>
          <p className="text-red-600">Something went wrong with the stream.</p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="mt-2 px-4 py-2 bg-red-600 text-white rounded"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}


export const LiveCreatorScreen = ({ onClose, LiveStreamService, currentUser, showToast }) => {
  const [tab, setTab] = useState('home'); 

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-950 text-white">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-red-700 to-purple-800 shadow-lg">
        <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full">
          <ArrowLeft size={20} />
        </button>
        <div className="flex items-center gap-2">
          <Radio size={18} className="text-red-300 animate-pulse" />
          <h1 className="text-lg font-bold">Creator Studio</h1>
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex border-b border-white/10 bg-gray-900">
        {[
          { id: 'home',    label: '🏠 Home' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 py-3 text-xs font-semibold transition-all border-b-2 ${
              tab === t.id ? 'border-red-500 text-red-400' : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* HOME TAB */}
        {tab === 'home' && (
          <div className="space-y-4">
            <div className="bg-gradient-to-r from-red-600/30 to-purple-600/30 rounded-2xl p-5 border border-red-500/30 text-center">
              <div className="w-20 h-20 bg-red-600 rounded-full flex items-center justify-center mx-auto mb-3 shadow-xl shadow-red-500/40">
                <Radio size={36} className="text-white animate-pulse" />
              </div>
              <h2 className="text-xl font-bold mb-1">Go Live Now</h2>
              <p className="text-sm text-gray-300 mb-4">Share your moment with your followers in real time</p>
              <button
                onClick={LiveStreamService}
                className="w-full py-3 bg-gradient-to-r from-red-600 to-red-500 text-white font-bold rounded-xl text-base hover:shadow-lg hover:shadow-red-500/40 transition-all flex items-center justify-center gap-2"
              >
                <Play size={18} fill="white" /> Start Broadcast
              </button>
            </div>

            <div className="bg-gray-800 rounded-xl p-4 space-y-2">
              <h3 className="font-semibold text-sm text-gray-300">📋 Before you go live</h3>
              {[
                'Ensure good lighting',
                'Check your internet connection',
                'Military plan: 2-min key rotation active',
                'Your stream is end-to-end encrypted',
              ].map((tip, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-gray-400">
                  <span className="text-green-400">✓</span>{tip}
                </div>
              ))}
            </div>
          </div>
        )}
        </div>
        </div>
  )};

// ============================================================================
// LIVE STREAM SERVICE
// ============================================================================
export class LiveStreamService {
  #broadcastClient = null;
  #hlsPlayer = null;
  #chatWebSocket = null;
  #chatToken = null;
  #chatEndpoint = null;
  #currentUser = null;
  #showToast = null;
  #api = null;
  #isBroadcasting = false;
  #giftTimestamps = [];
  #sessionStartTime = Date.now();
  #breakReminderInterval = null;
  #videoContainer = null;
  #analytics = {
    startTime: Date.now(),
    peakViewers: 0,
    totalRevenue: 0,
    giftsSent: 0
  };
  #callbacks = {
    message: [],
    gift: [],
    viewerUpdate: [],
    prediction: [],
    quiz: []
  };

  constructor(currentUser, showToast, apiInstance) {
    if (!currentUser?._id) throw new Error('currentUser._id is required');
    this.#currentUser = currentUser;
    this.#showToast = showToast;
    this.#api = apiInstance;
    this.#sessionStartTime = Date.now();
    this.#startBreakReminder();
  }

  #startBreakReminder() {
    this.#breakReminderInterval = setInterval(() => {
      const elapsed = Date.now() - this.#sessionStartTime;
      if (elapsed >= CONSTANTS.BREAK_REMINDER_MS) {
        this.#showToast("Take a break! You've been here 15+ minutes 😊", 'info');
        this.#sessionStartTime = Date.now();
      }
    }, CONSTANTS.BREAK_REMINDER_MS);
  }

  async initialize(channelName, role = 'audience') {
    try {
      if (role === 'host') {
        await this.#initBroadcaster(channelName);
      } else {
        await this.#initViewer(channelName);
      }
      await this.#initChat(channelName);
    } catch (error) {
      console.error('LiveStreamService.initialize error:', error);
      this.#showToast('Failed to connect to stream', 'error');
      throw error;
    }
  }

  setVideoContainer(container) {
    this.#videoContainer = container;
  }

  async #initBroadcaster(channelName) {
    const { streamKey, ingestEndpoint } =
      await this.#api.get(`/live/channel/${channelName}/credentials`);
    this.#broadcastClient = IVSBroadcastClient.create({
      streamConfig: IVSBroadcastClient.BASIC_FULL_HD,
      ingestEndpoint: ingestEndpoint
    });
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 44100
      }
    });
    const videoTrack = mediaStream.getVideoTracks()[0];
    const audioTrack = mediaStream.getAudioTracks()[0];
    await this.#broadcastClient.addVideoInputDevice(
      new MediaStream([videoTrack]),
      'camera',
      { index: 0 }
    );
    await this.#broadcastClient.addAudioInputDevice(
      new MediaStream([audioTrack]),
      'microphone'
    );
    if (this.#videoContainer) {
      const previewStream = this.#broadcastClient.getPreviewStream();
      this.#videoContainer.srcObject = previewStream;
      this.#videoContainer.play();
    }
    await this.#broadcastClient.startBroadcast(streamKey);
    this.#isBroadcasting = true;
    this.#broadcastClient.on(
      IVSBroadcastClient.BroadcastClientEvents.CONNECTION_STATE_CHANGE,
      (state) => {
        if (state === 'disconnected' && this.#isBroadcasting) {
          this.#showToast('Stream disconnected — reconnecting...', 'warning');
          setTimeout(() => this.#broadcastClient?.startBroadcast(streamKey), 3000);
        }
      }
    );
  }

  async #initViewer(channelName) {
    const { playbackUrl } = await this.#api.get(`/live/channel/${channelName}/playback`);
    if (!this.#videoContainer) {
      console.warn('Video container not set');
      return;
    }
    if (Hls.isSupported()) {
      this.#hlsPlayer = new Hls({
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        enableWorker: true
      });
      this.#hlsPlayer.loadSource(playbackUrl);
      this.#hlsPlayer.attachMedia(this.#videoContainer);
      this.#hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
        this.#videoContainer.play();
      });
    } else if (this.#videoContainer.canPlayType('application/vnd.apple.mpegurl')) {
      this.#videoContainer.src = playbackUrl;
      this.#videoContainer.play();
    } else {
      this.#showToast('Your browser does not support live video playback', 'error');
    }
  }

  async #initChat(channelName) {
    const { token, endpoint } =
      await this.#api.post('/live/chat/token', {
        channelName,
        userId: this.#currentUser._id,
        userName: this.#currentUser.name
      });
    this.#chatToken = token;
    this.#chatEndpoint = endpoint;
    this.#chatWebSocket = new WebSocket(endpoint, token);
    this.#chatWebSocket.onopen = () => {
      console.log('IVS Chat connected');
    };
    this.#chatWebSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.Type === 'MESSAGE') {
          const content = JSON.parse(data.Content);
          if (content.type === 'chat') {
            const message = {
              id: data.Id,
              sender: data.Sender?.Attributes?.username || 'Unknown',
              senderId: data.Sender?.UserId,
              text: content.text,
              replyTo: content.replyTo || null,
              taggedUser: content.taggedUser || null,
              timestamp: Date.now()
            };
            this.#callbacks.message.forEach(cb => cb(message));
          }
          if (content.type === 'gift') {
            this.#callbacks.gift.forEach(cb => cb(content));
          }
          if (content.type === 'viewer_count') {
            this.#analytics.peakViewers = Math.max(
              this.#analytics.peakViewers,
              content.count
            );
            this.#callbacks.viewerUpdate.forEach(cb => cb(content.count));
          }
          if (content.type === 'prediction_start') {
            this.#callbacks.prediction.forEach(cb => cb(content.data));
          }
          if (content.type === 'quiz_question') {
            this.#callbacks.quiz.forEach(cb => cb(content));
          }
        }
      } catch (err) {
        console.error('Chat message parse error:', err);
      }
    };
    this.#chatWebSocket.onerror = (err) => {
      console.error('IVS Chat WebSocket error:', err);
    };
    this.#chatWebSocket.onclose = () => {
      if (this.#isBroadcasting) {
        setTimeout(() => this.#initChat(channelName), 3000);
      }
    };
  }

  async sendMessage(text, replyTo = null, taggedUser = null) {
    if (!this.#chatWebSocket || this.#chatWebSocket.readyState !== WebSocket.OPEN) {
      this.#showToast('Chat not connected', 'error');
      return null;
    }
    const content = {
      type: 'chat',
      text,
      replyTo,
      taggedUser
    };
    const payload = {
      Action: 'SEND_MESSAGE',
      Content: JSON.stringify(content)
    };
    this.#chatWebSocket.send(JSON.stringify(payload));
    return {
      id: Date.now(),
      sender: this.#currentUser.name,
      senderId: this.#currentUser._id,
      text,
      replyTo,
      taggedUser,
      timestamp: Date.now()
    };
  }

  async sendGift(giftType, _channelName = null, mystery = false) {
    try {
      const now = Date.now();
      this.#giftTimestamps = this.#giftTimestamps.filter(t => now - t < 60000);
      if (this.#giftTimestamps.length >= CONSTANTS.MAX_GIFT_VELOCITY) {
        this.#showToast('Slow down! Take a breath 😊', 'warning');
        return { success: false, reason: 'velocity' };
      }
      this.#giftTimestamps.push(now);
      let finalGift = giftType;
      if (mystery && giftType.mystery) {
        const value = Math.floor(
          Math.random() * (giftType.maxValue - giftType.minValue + 1)
        ) + giftType.minValue;
        const options = GIFT_TYPES.filter(g => g.cost === value);
        finalGift = options.length
          ? options[Math.floor(Math.random() * options.length)]
          : giftType;
      }
      const giftData = {
        type: 'gift',
        id: now,
        giftType: finalGift.id,
        giftName: finalGift.name,
        giftIcon: finalGift.icon,
        cost: finalGift.cost,
        rarity: finalGift.rarity,
        animation: finalGift.animation,
        weight: finalGift.weight,
        sender: this.#currentUser.name,
        senderId: this.#currentUser._id,
        senderLevel: this.#currentUser.level || 1,
        timestamp: now,
        mystery
      };
      if (this.#chatWebSocket?.readyState === WebSocket.OPEN) {
        this.#chatWebSocket.send(JSON.stringify({
          Action: 'SEND_MESSAGE',
          Content: JSON.stringify(giftData)
        }));
      }
      await this.#api.post('/live/gift', giftData);
      this.#analytics.giftsSent += finalGift.cost;
      this.#analytics.totalRevenue += finalGift.cost;
      return { success: true, data: giftData };
    } catch (error) {
      console.error('Gift send failed:', error);
      this.#showToast('Gift failed to send', 'error');
      return { success: false, reason: 'error' };
    }
  }

  async sendTipMenuAction(tipItem, customAmount = null) {
    const amount = customAmount || tipItem.amount;
    const payload = {
      type: 'tip',
      action: tipItem.id,
      name: tipItem.name,
      icon: tipItem.icon,
      amount,
      message: tipItem.message,
      sender: this.#currentUser.name,
      senderId: this.#currentUser._id,
      timestamp: Date.now()
    };
    return await this.#api.post('/tips/send', payload);
  }

  async createPoll(question, options, type = 'simple', duration = 60) {
    const pollData = {
      id: `poll_${Date.now()}`,
      question,
      options: options.map(opt => ({ text: opt, votes: 0, voters: [] })),
      type,
      duration,
      createdAt: Date.now(),
      createdBy: this.#currentUser._id
    };
    if (this.#chatWebSocket?.readyState === WebSocket.OPEN) {
      this.#chatWebSocket.send(JSON.stringify({
        Action: 'SEND_MESSAGE',
        Content: JSON.stringify({ type: 'poll', data: pollData })
      }));
    }
    return pollData;
  }

  async createPrediction(question, options, duration = 60) {
    const prediction = {
      id: `pred_${Date.now()}`,
      question,
      options: options.map(opt => ({ text: opt, votes: 0, totalCoins: 0 })),
      duration,
      createdAt: Date.now(),
      status: 'active'
    };
    if (this.#chatWebSocket?.readyState === WebSocket.OPEN) {
      this.#chatWebSocket.send(JSON.stringify({
        Action: 'SEND_MESSAGE',
        Content: JSON.stringify({ type: 'prediction_start', data: prediction })
      }));
    }
    setTimeout(() => this.resolvePrediction(prediction.id), duration * 1000);
    return prediction;
  }

  async votePrediction(predictionId, optionIndex, coinAmount = 0) {
    if (this.#chatWebSocket?.readyState === WebSocket.OPEN) {
      this.#chatWebSocket.send(JSON.stringify({
        Action: 'SEND_MESSAGE',
        Content: JSON.stringify({
          type: 'prediction_vote',
          predictionId,
          optionIndex,
          coinAmount,
          voter: this.#currentUser.name
        })
      }));
    }
  }

  async startLiveQuiz() {
    const TRIVIA_QUESTIONS = [
      { q: "What's the capital of South Africa?", options: ["Cape Town", "Pretoria", "Johannesburg"], correct: 1 },
      { q: "Which currency is used in Nigeria?", options: ["Naira", "Cedi", "Shilling"], correct: 0 },
      { q: "What year did South Africa host the World Cup?", options: ["2008", "2010", "2012"], correct: 1 }
    ];
    let questionIndex = 0;
    const quizInterval = setInterval(() => {
      if (questionIndex >= TRIVIA_QUESTIONS.length) {
        clearInterval(quizInterval);
        this.endQuiz();
        return;
      }
      if (this.#chatWebSocket?.readyState === WebSocket.OPEN) {
        this.#chatWebSocket.send(JSON.stringify({
          Action: 'SEND_MESSAGE',
          Content: JSON.stringify({
            type: 'quiz_question',
            question: TRIVIA_QUESTIONS[questionIndex],
            timeLimit: 15
          })
        }));
      }
      questionIndex++;
    }, CONSTANTS.QUIZ_INTERVAL_MS);
  }

  async endQuiz() {
    if (this.#chatWebSocket?.readyState === WebSocket.OPEN) {
      this.#chatWebSocket.send(JSON.stringify({
        Action: 'SEND_MESSAGE',
        Content: JSON.stringify({ type: 'quiz_end' })
      }));
    }
  }

  async pinMessage(messageId, duration = 30) {
    if (this.#chatWebSocket?.readyState === WebSocket.OPEN) {
      this.#chatWebSocket.send(JSON.stringify({
        Action: 'SEND_MESSAGE',
        Content: JSON.stringify({
          type: 'pin_message',
          messageId,
          duration,
          sender: this.#currentUser.name
        })
      }));
    }
  }

  async blockUser(userId) {
    await this.#api.post('/live/block', { userId });
  }

  async pinUser(userId) {
    await this.#api.post('/live/pin-user', { userId });
  }

  async pinTopic(topic) {
    if (this.#chatWebSocket?.readyState === WebSocket.OPEN) {
      this.#chatWebSocket.send(JSON.stringify({
        Action: 'SEND_MESSAGE',
        Content: JSON.stringify({ type: 'topic', topic, timestamp: Date.now() })
      }));
    }
    await this.#api.post('/live/pin-topic', { topic });
  }

  async startScreenShare() {
    if (!this.#broadcastClient) return;
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      await this.#broadcastClient.addVideoInputDevice(
        new MediaStream([screenTrack]),
        'screen',
        { index: 1 }
      );
      screenTrack.onended = () => this.stopScreenShare();
    } catch (err) {
      this.#showToast('Screen share cancelled', 'info');
    }
  }

  async stopScreenShare() {
    if (!this.#broadcastClient) return;
    this.#broadcastClient.removeVideoInputDevice('screen');
  }

  async toggleMic(muted) {
    if (!this.#broadcastClient) return;
    const audioDevice = this.#broadcastClient.getAudioInputDevice('microphone');
    if (audioDevice) {
      audioDevice.getAudioTracks().forEach(t => { t.enabled = !muted; });
    }
  }

  async toggleCamera(hidden) {
    if (!this.#broadcastClient) return;
    const videoDevice = this.#broadcastClient.getVideoInputDevice('camera');
    if (videoDevice) {
      videoDevice.getVideoTracks().forEach(t => { t.enabled = !hidden; });
    }
  }

  setVideoQuality(quality) {
    if (this.#hlsPlayer) {
      const qualityLevel = CONSTANTS.DATA_SAVER_QUALITIES.indexOf(quality);
      this.#hlsPlayer.currentLevel = qualityLevel;
    }
  }

  async endStream() {
    const stats = {
      duration: Date.now() - this.#analytics.startTime,
      peakViewers: this.#analytics.peakViewers,
      totalRevenue: this.#analytics.totalRevenue
    };
    if (this.#isBroadcasting) {
      await this.#broadcastClient?.stopBroadcast();
      this.#isBroadcasting = false;
    }
    await this.#api.post('/live/end', { stats });
    return stats;
  }

  getAnalytics() {
    return {
      ...this.#analytics,
      duration: Date.now() - this.#analytics.startTime,
      avgRevenue: this.#analytics.totalRevenue /
        Math.max(1, (Date.now() - this.#analytics.startTime) / 60000)
    };
  }

  onMessage(cb) {
    this.#callbacks.message.push(cb);
    return () => {
      this.#callbacks.message = this.#callbacks.message.filter(fn => fn !== cb);
    };
  }

  onGift(cb) {
    this.#callbacks.gift.push(cb);
    return () => {
      this.#callbacks.gift = this.#callbacks.gift.filter(fn => fn !== cb);
    };
  }

  onViewerUpdate(cb) {
    this.#callbacks.viewerUpdate.push(cb);
    return () => {
      this.#callbacks.viewerUpdate = this.#callbacks.viewerUpdate.filter(fn => fn !== cb);
    };
  }

  onPrediction(cb) {
    this.#callbacks.prediction.push(cb);
    return () => {
      this.#callbacks.prediction = this.#callbacks.prediction.filter(fn => fn !== cb);
    };
  }

  onQuiz(cb) {
    this.#callbacks.quiz.push(cb);
    return () => {
      this.#callbacks.quiz = this.#callbacks.quiz.filter(fn => fn !== cb);
    };
  }

  async destroy() {
    clearInterval(this.#breakReminderInterval);
    if (this.#isBroadcasting) {
      await this.#broadcastClient?.stopBroadcast();
    }
    this.#broadcastClient?.removeAllListeners?.();
    this.#broadcastClient = null;
    this.#hlsPlayer?.destroy();
    this.#hlsPlayer = null;
    this.#chatWebSocket?.close();
    this.#chatWebSocket = null;
  }
}

// ============================================================================
// MAIN LIVE STREAM SYSTEM
// ============================================================================
export default function LiveStreamSystem({ 
  isBroadcaster, 
  currentUser, 
  apiInstance,
  onClose,        
  channelName,    
}) {
  const [state, dispatch] = useReducer(liveStreamReducer, initialState);
  const [service, setService] = useState(null);
  const [messageInput, setMessageInput] = useState('');
  const [replyingTo, setReplyingTo] = useState(null);
  const [taggedUser, setTaggedUser] = useState(null);
  const [showGiftStore, setShowGiftStore] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [showTipMenu, setShowTipMenu] = useState(false);
  const [showSubscription, setShowSubscription] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showSafetyModal, setShowSafetyModal] = useState(false);
  const [tapCompetitionActive, setTapCompetitionActive] = useState(false);
  const [currentLanguage, setCurrentLanguage] = useState('English');
  const [achievementToShow, setAchievementToShow] = useState(null);
  const [isShaking, triggerShake] = useScreenShake();
  const [showGiftStoreUltimate, setShowGiftStoreUltimate] = useState(false);
  const [showBrandDashboard, setShowBrandDashboard] = useState(false);
  const [showDataSaver, setShowDataSaver] = useState(false);
  const videoRef = useRef(null);
  const chatEndRef = useRef(null);
  const { sendStreamNotification } = usePushNotifications();
  const [streamStarted, setStreamStarted] = useState(false);

  useEffect(() => {
    if (!isBroadcaster && streamStarted) {
      sendStreamNotification(currentUser?.name || 'Your creator');
    }
  }, [streamStarted]);

  useEffect(() => {
    const initService = async () => {
      const srv = new LiveStreamService(currentUser, (msg, type) => {
        console.log(`Toast: ${msg} (${type})`);
      }, apiInstance);
      await srv.initialize('live-channel', isBroadcaster ? 'host' : 'audience');
      srv.setVideoContainer(videoRef.current);
      srv.onMessage(msg => {
        if (!state.blockedUsers.includes(msg.senderId)) {
          dispatch({ type: 'ADD_MESSAGE', payload: msg });
          setTimeout(() => dispatch({ type: 'REMOVE_MESSAGE', payload: msg.id }), CONSTANTS.CHAT_SCROLL_SPEED);
        }
      });
      srv.onGift(gift => {
        dispatch({ type: 'ADD_GIFT', payload: gift });
        dispatch({ type: 'UPDATE_GOAL', payload: gift.cost });
        setTimeout(() => dispatch({ type: 'REMOVE_GIFT', payload: gift.id }), 3000);
        if (gift.rarity === 'legendary' || gift.rarity === 'mythic') {
          triggerShake();
        }
        dispatch({ type: 'ADD_XP', payload: gift.weight * 10 });
        checkAchievements(state);
        // Update Hype Train
        updateHypeTrain(gift);
      });
      srv.onViewerUpdate(count => dispatch({ type: 'UPDATE_VIEWERS', payload: count }));
      srv.onPrediction(pred => {
        dispatch({ type: 'SET_ACTIVE_PREDICTION', payload: pred });
      });
      srv.onQuiz(quiz => {
        dispatch({ type: 'SET_QUIZ_QUESTION', payload: quiz.question });
        dispatch({ type: 'SET_QUIZ_TIMER', payload: quiz.timeLimit });
      });
      setService(srv);
    };
    initService();
    return () => service?.destroy();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      dispatch({ type: 'UPDATE_EARNINGS', payload: state.viewerEarnings + state.earningsPerSecond });
      if (!isBroadcaster && service) {
        dispatch({
          type: 'UPDATE_WATCH_TIME',
          payload: { userId: currentUser._id, time: 1000 }
        });
      }
      // Quiz timer countdown
      if (state.quizActive && state.quizTimer > 0) {
        dispatch({ type: 'SET_QUIZ_TIMER', payload: state.quizTimer - 1 });
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [state.viewerEarnings, state.earningsPerSecond, state.quizActive, state.quizTimer]);

  useEffect(() => {
    const topLikers = Object.entries(state.sessionLikes)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([userId, likes]) => ({ userId, likes }));
    dispatch({ type: 'UPDATE_TOP_LIKERS', payload: topLikers });
  }, [state.sessionLikes]);

  const checkAchievements = (currentState) => {
    if (currentState.giftHistory.length === 1) {
      unlockBadge(BADGES.FIRST_GIFT);
    }
    if (currentState.totalSpend >= 1000) {
      unlockBadge(BADGES.WHALE);
    }
  };

  const unlockBadge = (badge) => {
    dispatch({ type: 'ADD_BADGE', payload: badge });
    dispatch({ type: 'ADD_XP', payload: badge.xp });
    setAchievementToShow(badge);
    setTimeout(() => setAchievementToShow(null), 4000);
  };

  const updateHypeTrain = (gift) => {
    if (gift.cost >= 50) {
      dispatch({
        type: 'UPDATE_HYPE_TRAIN',
        payload: {
          active: true,
          level: state.hypeTrain.level + 1,
          progress: Math.min(100, state.hypeTrain.progress + 20),
          contributors: [...state.hypeTrain.contributors, { user: gift.sender, amount: gift.cost }]
        }
      });
    }
  };

  const [micMuted, setMicMuted] = useState(false);
  const [cameraHidden, setCameraHidden] = useState(false);

  const handleToggleMic = async () => {
    const next = !micMuted;
    setMicMuted(next);
    await service?.toggleMic(next);
  };

  const handleToggleCamera = async () => {
    const next = !cameraHidden;
    setCameraHidden(next);
    await service?.toggleCamera(next);
  };

  const handleSendMessage = async () => {
    if (!messageInput.trim() || !service) return;
    await service.sendMessage(messageInput, replyingTo, taggedUser);
    setMessageInput('');
    setReplyingTo(null);
    setTaggedUser(null);
  };

  const handleSendGift = async (gift) => {
    if (state.dailySpend >= CONSTANTS.MAX_DAILY_SPEND) {
      setShowSafetyModal(true);
      return;
    }
    if (state.coins < gift.cost || !service) return;
    const result = await service.sendGift(gift, null, gift.mystery);
    if (result.success) {
      dispatch({ type: 'UPDATE_COINS', payload: state.coins - gift.cost });
      dispatch({ type: 'ADD_XP', payload: gift.weight * 10 });
      setShowGiftStore(false);
      setShowGiftStoreUltimate(false);
    }
  };

  const handleLike = () => {
    dispatch({ type: 'ADD_LIKE', payload: currentUser._id });
  };

  const handleTap = () => {
    const newScore = state.tapScore + 1;
    const newCombo = state.tapCombo + 1;
    dispatch({ type: 'UPDATE_TAP_SCORE', payload: { score: newScore, combo: newCombo } });
    dispatch({ type: 'ADD_LIKE' });
    setTimeout(() => {
      dispatch({ type: 'UPDATE_TAP_SCORE', payload: { score: state.tapScore, combo: 0 } });
    }, CONSTANTS.TAP_COMPETITION.COMBO_WINDOW);
  };

  const handleBlockUser = async (userId) => {
    await service.blockUser(userId);
    dispatch({ type: 'BLOCK_USER', payload: userId });
  };

  const handlePinUser = async (userId) => {
    await service.pinUser(userId);
    dispatch({ type: 'PIN_USER', payload: userId });
  };

  const handlePinTopic = async (topic) => {
    await service.pinTopic(topic);
    dispatch({ type: 'PIN_TOPIC', payload: topic });
  };

  const handleARFilterSelect = (filter) => {
    if (state.coins < filter.cost) return;
    if (state.activeARFilters.some(f => f.id === filter.id)) {
      dispatch({ type: 'REMOVE_AR_FILTER', payload: filter.id });
    } else {
      dispatch({ type: 'UPDATE_COINS', payload: state.coins - filter.cost });
      dispatch({ type: 'ADD_AR_FILTER', payload: filter });
    }
  };

 const handleEndStream = async () => {
  try {
    const stats = await service?.endStream?.() ?? {};
    dispatch({ type: 'TOGGLE_END_STREAM' });
    onClose?.(stats);
  } catch (err) {
    console.error('[Live] End stream error:', err);
    onClose?.({});
  }
};

  const handleToggleDataSaver = () => {
    const newState = !state.dataSaverEnabled;
    dispatch({ type: 'TOGGLE_DATA_SAVER', payload: newState });
    if (service) {
      service.setVideoQuality(newState ? '240p' : 'auto');
    }
  };

  const handleActivateBrand = (brandId) => {
    const brand = BRAND_PARTNERS[brandId];
    dispatch({ type: 'SET_ACTIVE_BRAND', payload: brand });
    dispatch({ type: 'SET_BRAND_MODE', payload: true });
    dispatch({ type: 'TOGGLE_SHOPPING' });
  };

  const currentGoal = CONSTANTS.LIKES_PER_GOAL_TIER.find(g => state.likes < g) || CONSTANTS.LIKES_PER_GOAL_TIER[CONSTANTS.LIKES_PER_GOAL_TIER.length - 1];
  const goalProgress = (state.likes / currentGoal) * 100;
  const streamDuration = Date.now() - state.streamStartTime;
  const level = calculateLevel(state.viewerXP);

  return (
    <div className={`fixed inset-0 bg-gradient-to-br from-purple-900 via-pink-900 to-red-900 flex flex-col overflow-hidden ${isShaking ? 'animate-shake' : ''}`}>
      <div className="flex-1 relative">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover bg-black"
          autoPlay
          playsInline
          muted={isBroadcaster}
        />

        {/* Battle Mode */}
        <BattleMode
          battleState={state.battleState}
          opponent={state.battleOpponent}
          score={state.battleScore}
          timer={state.battleTimer}
        />

        {/* Pinned Message */}
        <AnimatePresence>
          {state.pinnedMessage && (
            <PinnedMessage
              message={state.pinnedMessage}
              onClose={() => dispatch({ type: 'PIN_MESSAGE', payload: null })}
            />
          )}
        </AnimatePresence>

        {/* Active Poll */}
        <AnimatePresence>
          {state.activePoll && (
            <PollOverlay
              poll={state.activePoll}
              onVote={(pollId, optionIdx) => {}}
              userCoins={state.coins}
            />
          )}
        </AnimatePresence>

        {/* Active Prediction */}
        <AnimatePresence>
          {state.activePrediction && (
            <PredictionOverlay
              prediction={state.activePrediction}
              onVote={(predId, optionIdx, coins) => {
                service?.votePrediction(predId, optionIdx, coins);
              }}
              userCoins={state.coins}
            />
          )}
        </AnimatePresence>

        {/* Quiz Overlay */}
        <AnimatePresence>
          {state.quizActive && state.quizQuestion && (
            <QuizOverlay
              question={state.quizQuestion}
              timer={state.quizTimer}
              onAnswer={(answerIdx) => {}}
            />
          )}
        </AnimatePresence>

        {/* Tap Competition */}
        {tapCompetitionActive && (
          <TapCompetition
            isActive={tapCompetitionActive}
            onTap={handleTap}
            score={state.tapScore}
            combo={state.tapCombo}
            leaderboard={state.tapLeaderboard}
          />
        )}
        
        {/* Hype Train */}
        {state.hypeTrain.active && (
          <HypeTrainBanner
            level={state.hypeTrain.level}
            progress={state.hypeTrain.progress}
            contributors={state.hypeTrain.contributors}
          />
        )}

        {/* Brand Mode Indicator */}
        {state.brandMode && state.activeBrand && (
          <BrandModeIndicator
            brand={state.activeBrand}
            earnings={state.adSlots.earnings.today}
          />
        )}

        {/* Live Shopping Overlay */}
        {state.shoppingActive && state.activeBrand && (
          <BrandShoppingOverlay
            brand={state.activeBrand}
            products={state.activeBrand.products}
            onPurchase={(product) => {}}
            purchaseMode="both"
            targetUser={currentUser}
          />
        )}

        {/* AR Filters Display */}
        {state.activeARFilters.length > 0 && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex gap-2">
            {state.activeARFilters.map(f => (
              <div key={f.id} className="bg-black/60 backdrop-blur px-3 py-1 rounded-full border border-pink-500/50 text-white text-xs font-bold flex items-center gap-2">
                <span>{f.icon}</span>
                <span>{f.name}</span>
              </div>
            ))}
          </div>
        )}

        {/* Goal Progress */}
        <GoalProgress
          current={state.goals.current}
          target={state.goals.target}
          title={state.goals.title}
        />

        {/* Progression HUD */}
        <ProgressionHUD
          xp={state.viewerXP}
          streak={state.streak}
          badges={state.badges}
        />

        {/* Data Saver Toggle */}
        <button
          onClick={handleToggleDataSaver}
          className={`absolute top-4 right-4 z-30 px-3 py-2 rounded-full text-xs font-bold flex items-center gap-2 ${
            state.dataSaverEnabled ? 'bg-green-600 text-white' : 'bg-black/60 text-white'
          }`}
        >
          <Smartphone size={14} />
          {state.dataSaverEnabled ? 'Data Saver ON' : 'Data Saver'}
        </button>

        {/* Top Bar */}
        <div className="absolute top-0 left-0 right-0 p-3 sm:p-4 flex justify-between items-start z-30">
          <div className="flex items-center gap-2 sm:gap-3">
            <button className="p-1.5 sm:p-2 bg-black/40 backdrop-blur rounded-full">
              <X className="text-white" size={16} />
            </button>
            <div className="bg-black/40 backdrop-blur rounded-full px-2 sm:px-3 py-1 sm:py-1.5 flex items-center gap-1.5 sm:gap-2">
              <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 bg-red-500 rounded-full animate-pulse" />
              <span className="text-white text-xs sm:text-sm font-bold">LIVE</span>
              <span className="text-white/80 text-xs sm:text-sm">{formatDuration(streamDuration)}</span>
            </div>
            <div className="bg-black/40 backdrop-blur rounded-full px-2 sm:px-3 py-1 sm:py-1.5 flex items-center gap-1 sm:gap-1.5">
              <Users className="text-white" size={12} />
              <span className="text-white text-xs sm:text-sm">{formatNumber(state.viewers)}</span>
            </div>
          </div>
          <div className="flex gap-1.5 sm:gap-2">
            <LanguageSelector
              currentLang={currentLanguage}
              onSelect={setCurrentLanguage}
              languages={CONSTANTS.LANGUAGES}
            />
            {isBroadcaster && (
              <>
                <button
                  onClick={() => setShowAnalytics(true)}
                  className="p-1.5 sm:p-2 bg-black/40 backdrop-blur rounded-full text-green-400"
                >
                  <TrendingUp className="text-green-400" size={16} />
                </button>
                <button
                  onClick={() => setShowBrandDashboard(true)}
                  className="p-1.5 sm:p-2 bg-black/40 backdrop-blur rounded-full text-yellow-400"
                >
                  <Store className="text-yellow-400" size={16} />
                </button>
              </>
            )}
            <button className="p-1.5 sm:p-2 bg-black/40 backdrop-blur rounded-full">
              <Share2 className="text-white" size={16} />
            </button>
          </div>
        </div>

        {/* Right Side Action Buttons */}
        <div className="absolute right-2 sm:right-4 bottom-32 sm:bottom-36 flex flex-col gap-2 sm:gap-3 z-20">
          <button onClick={() => setShowGiftStoreUltimate(true)} className="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-r from-pink-500 to-purple-500 rounded-full flex items-center justify-center shadow-lg">
            <Gift className="text-white" size={20} />
          </button>
          <button onClick={() => setShowTipMenu(true)} className="w-10 h-10 sm:w-14 sm:h-14 bg-gradient-to-r from-orange-500 to-red-500 rounded-full flex items-center justify-center shadow-lg">
            <Coffee className="text-white" size={18} />
          </button>
          <button
            onClick={() => setTapCompetitionActive(!tapCompetitionActive)}
            className={`w-10 h-10 sm:w-14 sm:h-14 rounded-full flex flex-col items-center justify-center shadow-lg transition-all ${
              tapCompetitionActive
                ? 'bg-pink-500 scale-110'
                : 'bg-white/20 backdrop-blur'
            }`}
          >
            <Heart className="text-white" size={18} />
            <span className="text-white text-[8px] sm:text-[10px] font-bold">{formatNumber(state.likes)}</span>
          </button>
          <button onClick={() => dispatch({ type: 'TOGGLE_AR_GALLERY' })} className="w-10 h-10 sm:w-14 sm:h-14 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full flex items-center justify-center shadow-lg relative">
            <Sparkles className="text-white" size={18} />
            {state.activeARFilters.length > 0 && (
              <div className="absolute -top-1 -right-1 w-4 h-4 sm:w-5 sm:h-5 bg-green-500 rounded-full flex items-center justify-center text-white text-[10px] font-bold">
                {state.activeARFilters.length}
              </div>
            )}
          </button>
          {!isBroadcaster && (
            <button onClick={() => dispatch({ type: 'TOGGLE_EARNINGS' })} className="w-10 h-10 sm:w-14 sm:h-14 bg-gradient-to-r from-green-500 to-emerald-500 rounded-full flex flex-col items-center justify-center shadow-lg animate-pulse">
              <DollarSign className="text-white" size={18} />
              <span className="text-white text-[8px] sm:text-[10px] font-bold">${state.viewerEarnings.toFixed(2)}</span>
            </button>
          )}
        </div>

        {/* Bottom Chat Area */}
        <div className="absolute bottom-0 left-0 right-0 p-3 sm:p-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent z-20">
          <div className="h-32 sm:h-48 overflow-hidden mb-3 sm:mb-4">
            <AnimatePresence>
              {state.messages.map((msg, idx) => (
                <ChatMessage key={idx} message={msg} isOwn={msg.senderId === currentUser._id} />
              ))}
            </AnimatePresence>
            <div ref={chatEndRef} />
            {state.topLikers.length > 0 && (
              <div className="text-yellow-400 text-xs font-bold mb-2">
                🏆 {state.topLikers[0].userId.slice(0, 8)} Top Liker
              </div>
            )}
          </div>
          {replyingTo && (
            <div className="mb-2 bg-white/10 rounded-lg px-3 py-2 flex items-center justify-between">
              <span className="text-white/60 text-xs">Replying to @{replyingTo.sender}</span>
              <button onClick={() => setReplyingTo(null)}>
                <X className="text-white" size={14} />
              </button>
            </div>
          )}
          <div className="flex gap-2">
            {isBroadcaster && (
              <button onClick={() => handlePinTopic(prompt('Enter topic:'))} className="p-2 sm:p-2.5 bg-white/20 backdrop-blur rounded-full">
                <Hash className="text-white" size={16} />
              </button>
            )}
            <input
              type="text"
              value={messageInput}
              onChange={e => setMessageInput(e.target.value)}
              onKeyPress={e => e.key === 'Enter' && handleSendMessage()}
              placeholder={taggedUser ? `@${taggedUser}` : 'Say something...'}
              className="flex-1 bg-white/20 backdrop-blur rounded-full px-3 sm:px-4 py-2 sm:py-3 text-white text-sm sm:text-base placeholder-white/60 focus:outline-none focus:ring-2 focus:ring-pink-500"
            />
            <button onClick={handleSendMessage} className="p-2 sm:p-3 bg-pink-500 rounded-full">
              <Send className="text-white" size={16} />
            </button>
          </div>
        </div>

        {/* End Stream Button */}
        {isBroadcaster && (
          <button onClick={handleEndStream} className="absolute top-3 right-3 sm:top-4 sm:right-4 bg-red-600 text-white px-3 sm:px-4 py-1.5 sm:py-2 rounded-full font-bold text-xs sm:text-sm z-20">
            End Stream
          </button>
        )}
      </div>

      {/* Modals */}
      <ARFilterGallery
        isOpen={state.showARGallery}
        onClose={() => dispatch({ type: 'TOGGLE_AR_GALLERY' })}
        onSelectFilter={handleARFilterSelect}
        userCoins={state.coins}
        activeFilters={state.activeARFilters}
      />
      <ViewerEarningsModal
        isOpen={state.showEarningsModal}
        onClose={() => dispatch({ type: 'TOGGLE_EARNINGS' })}
        earnings={state.viewerEarnings}
        earningsPerSecond={state.earningsPerSecond}
        watchTime={state.totalWatchTime}
      />
      <GiftStoreUltimate
        isOpen={showGiftStoreUltimate}
        onClose={() => setShowGiftStoreUltimate(false)}
        onSendGift={handleSendGift}
        userCoins={state.coins}
        userLevel={level.level}
        subscription={state.subscription}
      />
      <TipMenuOverlay
        isOpen={showTipMenu}
        onClose={() => setShowTipMenu(false)}
        onSendTip={(tip) => service?.sendTipMenuAction(tip)}
        tipMenu={TIP_MENU}
      />
      <SubscriptionModal
        isOpen={showSubscription}
        onClose={() => setShowSubscription(false)}
        onSubscribe={(tier) => {
          dispatch({ type: 'SET_SUBSCRIPTION', payload: tier });
          setShowSubscription(false);
        }}
        tiers={SUBSCRIPTION_TIERS}
      />
      <AnalyticsDashboard
        isOpen={showAnalytics}
        onClose={() => setShowAnalytics(false)}
        analytics={service?.getAnalytics()}
      />
      <BrandDashboard
        isOpen={showBrandDashboard}
        onClose={() => setShowBrandDashboard(false)}
        currentUser={currentUser}
        onActivateBrand={handleActivateBrand}
      />
      <EndStreamModal
        isOpen={state.showEndStream}
        onClose={() => dispatch({ type: 'TOGGLE_END_STREAM' })}
        onSave={async () => {}}
        onRepost={async () => {}}
        onDiscard={async () => {}}
        stats={{
          duration: streamDuration,
          peakViewers: state.viewers,
          totalLikes: state.likes,
          totalRevenue: state.totalRevenue,
          sessionWatchTime: state.sessionWatchTime,
          sessionLikes: state.sessionLikes
        }}
      />

      <style jsx>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-10px) rotate(-1deg); }
          75% { transform: translateX(10px) rotate(1deg); }
        }
        .animate-shake {
          animation: shake 0.5s ease-in-out;
        }
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS - CONSOLIDATED
// ============================================================================

// 1. HYPE TRAIN BANNER
const HypeTrainBanner = ({ level, progress, contributors }) => (
  <motion.div
    initial={{ y: -100 }}
    animate={{ y: 0 }}
    className="absolute top-20 left-4 right-4 z-30"
  >
    <div className="bg-gradient-to-r from-orange-600 via-red-600 to-pink-600 rounded-2xl p-4 border-2 border-yellow-400 shadow-lg">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Flame className="text-yellow-400" size={24} />
          <span className="text-white font-black text-lg">HYPE TRAIN LEVEL {level}</span>
        </div>
        <span className="text-white/80 text-sm">{contributors.length} contributors</span>
      </div>
      <div className="h-4 bg-black/40 rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-gradient-to-r from-yellow-400 via-orange-500 to-red-500"
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
        />
      </div>
    </div>
  </motion.div>
);

// 2. BRAND MODE INDICATOR
const BrandModeIndicator = ({ brand, earnings }) => (
  <motion.div
    initial={{ y: -100 }}
    animate={{ y: 0 }}
    className="absolute top-32 left-4 right-4 z-30"
  >
    <div
      className="rounded-2xl p-4 border-2 border-white/30 shadow-lg flex items-center justify-between"
      style={{ background: brand.color }}
    >
      <div className="flex items-center gap-3">
        <img src={brand.logo} alt={brand.name} className="w-10 h-10 rounded-full bg-white p-1" />
        <div>
          <div className="text-white font-bold">Brand Mode: {brand.name}</div>
          <div className="text-white/80 text-sm">Earn commission on sales!</div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-white/80 text-xs">Session Earnings</div>
        <div className="text-white font-black text-xl">+R{earnings}</div>
      </div>
    </div>
  </motion.div>
);

// 3. BRAND SHOPPING OVERLAY
const BrandShoppingOverlay = ({ brand, products, onPurchase, purchaseMode, targetUser }) => {
  const [cart, setCart] = useState([]);
  const [showCheckout, setShowCheckout] = useState(false);

  const addToCart = (product) => {
    setCart([...cart, product]);
  };

  return (
    <div className="absolute right-0 top-20 w-64 bg-black/80 backdrop-blur rounded-l-2xl p-4 z-30">
      <div className="flex items-center gap-2 mb-3" style={{ color: brand.color }}>
        <ShoppingBag size={20} />
        <h3 className="text-white font-bold">Live Shop</h3>
      </div>
      {products.map(product => (
        <div key={product.id} className="mb-3 bg-white/10 rounded-xl p-3">
          <img src={product.image} className="w-full h-24 object-cover rounded-lg mb-2" />
          <p className="text-white text-sm font-bold">{product.name}</p>
          <div className="flex justify-between items-center mt-2">
            <span className="text-green-400 font-bold">${product.price}</span>
            <button
              onClick={() => addToCart(product)}
              className="bg-pink-500 text-white px-3 py-1 rounded-full text-xs font-bold"
            >
              {purchaseMode === 'gift' ? '🎁 Gift' : '🛒 Add'}
            </button>
          </div>
        </div>
      ))}
      {cart.length > 0 && (
        <button
          onClick={() => setShowCheckout(true)}
          className="w-full bg-green-500 text-white py-2 rounded-xl font-bold"
        >
          Checkout ({cart.length}) - ${cart.reduce((s, i) => s + i.price, 0)}
        </button>
      )}
    </div>
  );
};

// 4. PREDICTION OVERLAY
const PredictionOverlay = ({ prediction, onVote, userCoins }) => {
  if (!prediction) return null;
  const totalVotes = prediction.options.reduce((sum, opt) => sum + opt.votes, 0);

  return (
    <motion.div
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 100, opacity: 0 }}
      className="absolute bottom-80 left-4 right-4 z-25 bg-black/80 backdrop-blur-md rounded-3xl p-4 border border-white/20"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-bold flex items-center gap-2">
          <Target size={20} className="text-purple-400" />
          {prediction.question}
        </h3>
        <div className="text-white/60 text-sm">{prediction.duration}s</div>
      </div>
      <div className="space-y-2">
        {prediction.options.map((option, idx) => {
          const percentage = totalVotes > 0 ? (option.votes / totalVotes) * 100 : 0;
          return (
            <button
              key={idx}
              onClick={() => onVote(prediction.id, idx, 10)}
              className="w-full relative"
            >
              <div className="bg-white/10 rounded-xl overflow-hidden border border-white/20 hover:border-purple-400 transition-colors">
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-purple-500/30 to-pink-500/30"
                  style={{ width: `${percentage}%` }}
                />
                <div className="relative px-4 py-3 flex items-center justify-between">
                  <span className="text-white font-medium">{option.text}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-white/60 text-sm">{option.votes}</span>
                    <span className="text-purple-400 font-bold">{percentage.toFixed(0)}%</span>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-3 text-center text-yellow-400 text-xs">
        💰 Vote with coins for weighted influence
      </div>
    </motion.div>
  );
};

// 5. QUIZ OVERLAY
const QuizOverlay = ({ question, timer, onAnswer }) => {
  if (!question) return null;

  return (
    <motion.div
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 100, opacity: 0 }}
      className="absolute bottom-80 left-4 right-4 z-25 bg-black/80 backdrop-blur-md rounded-3xl p-4 border border-white/20"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-bold flex items-center gap-2">
          <Award size={20} className="text-blue-400" />
          Live Quiz!
        </h3>
        <div className="text-white/60 text-sm flex items-center gap-1">
          <Timer size={14} />
          {timer}s
        </div>
      </div>
      <p className="text-white text-lg font-bold mb-4">{question.q}</p>
      <div className="space-y-2">
        {question.options.map((option, idx) => (
          <button
            key={idx}
            onClick={() => onAnswer(idx)}
            className="w-full bg-white/10 rounded-xl px-4 py-3 text-white font-medium hover:bg-blue-500/30 transition-colors border border-white/20"
          >
            {option}
          </button>
        ))}
      </div>
    </motion.div>
  );
};

// 6. BRAND DASHBOARD
const BrandDashboard = ({ isOpen, onClose, currentUser, onActivateBrand }) => {
  if (!isOpen) return null;
  const creatorTier = currentUser?.subscription?.tier || 'bronze';
  const tier = SUBSCRIPTION_TIERS.find(t => t.id === creatorTier);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-60 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9 }}
        animate={{ scale: 1 }}
        className="bg-gray-900 w-full max-w-4xl rounded-3xl p-6 border border-white/10"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-white text-2xl font-bold flex items-center gap-2">
            <Store className="text-yellow-400" />
            Brand Advertising Dashboard
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={24} />
          </button>
        </div>

        {/* Ad Slot Status */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-white/5 rounded-2xl p-4">
            <div className="text-gray-400 text-sm mb-1">Daily Slots Used</div>
            <div className="text-white text-3xl font-bold">
              0 / {tier?.adSlots?.daily || 1}
            </div>
          </div>
          <div className="bg-white/5 rounded-2xl p-4">
            <div className="text-gray-400 text-sm mb-1">Weekly Premium Slots</div>
            <div className="text-white text-3xl font-bold">
              0 / {tier?.adSlots?.weekly || 1}
            </div>
          </div>
        </div>

        {/* Available Brands */}
        <div className="mb-6">
          <h3 className="text-white font-bold mb-4">Available Brand Partners</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {Object.values(BRAND_PARTNERS).map(brand => (
              <div
                key={brand.id}
                className="bg-white/5 rounded-2xl p-4 border border-white/10 hover:border-yellow-400 transition-colors"
              >
                <div className="flex items-center gap-3 mb-3">
                  <img src={brand.logo} alt={brand.name} className="w-12 h-12 rounded-full bg-white p-1" />
                  <div>
                    <div className="text-white font-bold">{brand.name}</div>
                    <div className="text-green-400 text-sm">{brand.payoutRate * 100}% commission</div>
                  </div>
                </div>
                <div className="text-gray-400 text-xs mb-3">
                  {brand.products.length} products available
                </div>
                <button
                  onClick={() => onActivateBrand(brand.id)}
                  className="w-full bg-gradient-to-r from-yellow-500 to-orange-500 text-white py-2 rounded-xl font-bold text-sm"
                >
                  Activate Brand Mode
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Earnings */}
        <div className="bg-gradient-to-r from-green-900/30 to-emerald-900/30 rounded-2xl p-4 border border-green-500/30">
          <h3 className="text-white font-bold mb-3">💰 Brand Earnings</h3>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-green-400 text-2xl font-bold">R0.00</div>
              <div className="text-gray-400 text-xs">Today</div>
            </div>
            <div>
              <div className="text-green-400 text-2xl font-bold">R0.00</div>
              <div className="text-gray-400 text-xs">This Week</div>
            </div>
            <div>
              <div className="text-green-400 text-2xl font-bold">R0.00</div>
              <div className="text-gray-400 text-xs">Pending</div>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

// 7. GOAL PROGRESS
const GoalProgress = ({ current, target, title }) => {
  const progress = Math.min(100, (current / target) * 100);
  const nearComplete = progress > 90;

  return (
    <motion.div
      initial={{ y: -50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="absolute top-16 left-4 right-4 z-20"
    >
      <div className="bg-black/60 backdrop-blur-md rounded-2xl p-3 border border-white/10">
        <div className="flex justify-between text-white text-xs mb-1 font-bold">
          <span>{title}</span>
          <span>{formatCurrency(current)} / {formatCurrency(target)}</span>
        </div>
        <div className="h-3 bg-white/20 rounded-full overflow-hidden relative">
          <motion.div
            className={`h-full ${nearComplete ? 'bg-gradient-to-r from-yellow-400 to-orange-500' : 'bg-pink-500'}`}
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ type: 'spring', stiffness: 50 }}
          />
        </div>
        {nearComplete && (
          <motion.div className="text-center text-yellow-400 text-xs mt-1 font-bold">
            Almost there! 🎁
          </motion.div>
        )}
      </div>
    </motion.div>
  );
};

// 8. PROGRESSION HUD
const ProgressionHUD = ({ xp, streak, badges }) => {
  const level = calculateLevel(xp);
  const nextLevel = VIEWER_LEVELS.find(l => l.level === level.level + 1) || level;
  const progress = ((xp - level.minXP) / (nextLevel.minXP - level.minXP)) * 100;

  return (
    <motion.div
      initial={{ x: -100 }}
      animate={{ x: 0 }}
      className="absolute top-20 left-4 z-20"
    >
      <div className="bg-black/60 backdrop-blur-md rounded-2xl p-3 border border-white/10 text-white">
        <div className="flex items-center gap-3 mb-2">
          <div className="text-2xl">{level.icon}</div>
          <div>
            <div className="font-bold text-sm">{level.name}</div>
            <div className="text-xs text-gray-400">Level {level.level}</div>
          </div>
        </div>
        <div className="w-32 h-2 bg-white/20 rounded-full overflow-hidden mb-2">
          <motion.div
            className="h-full bg-gradient-to-r from-green-400 to-blue-500"
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
          />
        </div>
        {streak > 0 && (
          <div className="flex items-center gap-1 text-orange-400 text-xs font-bold">
            <Flame size={12} />
            {streak} day streak!
          </div>
        )}
        <div className="flex gap-1 mt-2">
          {badges.slice(0, 3).map(badge => (
            <div key={badge.id} title={badge.name} className="text-lg">
              {badge.icon}
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
};

// 9. CHAT MESSAGE
const ChatMessage = ({ message, isOwn }) => (
  <div className={`flex gap-2 mb-2 ${isOwn ? 'flex-row-reverse' : ''}`}>
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white text-xs font-bold">
      {message.sender[0]}
    </div>
    <div className={`max-w-[70%] px-3 py-2 rounded-2xl text-sm ${
      isOwn ? 'bg-pink-500 text-white rounded-br-none' : 'bg-white/10 text-white rounded-bl-none'
    }`}>
      <div className="text-xs opacity-80 font-bold mb-0.5">{message.sender}</div>
      {message.text}
    </div>
  </div>
);

// 10. TAP COMPETITION OVERLAY
const TapCompetition = ({ isActive, onTap, score, combo, leaderboard }) => {
  const [ripples, setRipples] = useState([]);

  const handleTap = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setRipples([...ripples, { id: Date.now(), x, y }]);
    setTimeout(() => setRipples(r => r.filter(ripple => ripple.id !== Date.now())), 1000);
    onTap();
  };

  if (!isActive) return null;

  return (
    <div
      className="absolute inset-0 z-40 cursor-pointer select-none"
      onMouseDown={handleTap}
      onTouchStart={handleTap}
    >
      {ripples.map(ripple => (
        <motion.div
          key={ripple.id}
          initial={{ scale: 0, opacity: 1 }}
          animate={{ scale: 3, opacity: 0 }}
          transition={{ duration: 0.6 }}
          className="absolute w-20 h-20 rounded-full border-4 border-pink-500 pointer-events-none"
          style={{ left: ripple.x - 40, top: ripple.y - 40 }}
        />
      ))}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none">
        <motion.div
          animate={{ scale: combo > 1 ? [1, 1.2, 1] : 1 }}
          className="text-9xl font-black text-white drop-shadow-2xl"
          style={{ textShadow: '0 0 40px rgba(236,72,153,0.8)' }}
        >
          {score}
        </motion.div>
        {combo > 1 && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="text-4xl font-bold text-yellow-400 mt-4"
          >
            x{combo} COMBO!
          </motion.div>
        )}
        <div className="text-xl text-white/80 mt-2 font-bold">
          TAP TO LIKE! ❤️
        </div>
      </div>
      <div className="absolute bottom-32 right-4 bg-black/60 backdrop-blur-md rounded-2xl p-3 border border-white/20 pointer-events-none">
        <div className="text-white text-xs font-bold mb-2 flex items-center gap-2">
          <Trophy size={14} className="text-yellow-400" />
          Top Tappers
        </div>
        {leaderboard.slice(0, 3).map((user, idx) => (
          <div key={idx} className="flex items-center gap-2 text-white text-xs mb-1">
            <span className="w-4">{idx + 1}.</span>
            <span className="flex-1 truncate">{user.name}</span>
            <span className="text-pink-400 font-bold">{formatNumber(user.taps)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// 11. BATTLE/PK MODE DISPLAY
const BattleMode = ({ battleState, opponent, score, timer }) => {
  if (battleState === BATTLE_STATES.IDLE) return null;

  return (
    <motion.div
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      className="absolute top-20 left-0 right-0 z-30 px-4"
    >
      <div className="bg-gradient-to-r from-red-600 via-purple-600 to-blue-600 rounded-3xl p-4 border-4 border-white/30 shadow-2xl">
        <div className="text-center mb-3">
          <div className="text-white text-6xl font-black">
            {Math.floor(timer / 60)}:{(timer % 60).toString().padStart(2, '0')}
          </div>
          <div className="text-white/80 text-sm font-bold uppercase tracking-wider">
            Battle Time!
          </div>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 text-center">
            <div className="text-white text-4xl font-black mb-2">{score.us}</div>
            <div className="text-white/80 text-sm font-bold">Your Side</div>
          </div>
          <div className="relative">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
              className="w-16 h-16 rounded-full bg-white flex items-center justify-center"
            >
              <Swords className="text-purple-600" size={32} />
            </motion.div>
          </div>
          <div className="flex-1 text-center">
            <div className="text-white text-4xl font-black mb-2">{score.them}</div>
            <div className="text-white/80 text-sm font-bold">
              {opponent?.name || 'Opponent'}
            </div>
          </div>
        </div>
        <div className="mt-4 space-y-2">
          <div className="h-3 bg-white/20 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-pink-500 to-red-500"
              initial={{ width: 0 }}
              animate={{ width: `${(score.us / (score.us + score.them + 1)) * 100}%` }}
            />
          </div>
          <div className="h-3 bg-white/20 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-blue-500 to-purple-500"
              initial={{ width: 0 }}
              animate={{ width: `${(score.them / (score.us + score.them + 1)) * 100}%` }}
            />
          </div>
        </div>
        <motion.div
          animate={{ scale: [1, 1.1, 1] }}
          transition={{ duration: 1, repeat: Infinity }}
          className="text-center mt-3 text-yellow-300 font-bold text-lg"
        >
          Send gifts to win! 🎁
        </motion.div>
      </div>
    </motion.div>
  );
};

// 12. PINNED MESSAGE DISPLAY
const PinnedMessage = ({ message, onClose }) => {
  if (!message) return null;

  return (
    <motion.div
      initial={{ y: -50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -50, opacity: 0 }}
      className="absolute top-4 left-4 right-4 z-25 bg-gradient-to-r from-yellow-600 to-orange-600 rounded-2xl p-3 border-2 border-yellow-300 shadow-lg"
    >
      <div className="flex items-start gap-2">
        <Pin className="text-white flex-shrink-0 mt-0.5" size={20} />
        <div className="flex-1">
          <div className="text-white text-xs font-bold mb-1">PINNED MESSAGE</div>
          <div className="text-white text-sm">{message.text}</div>
          <div className="text-white/70 text-xs mt-1">by {message.sender}</div>
        </div>
        <button onClick={onClose} className="text-white/80 hover:text-white">
          <X size={18} />
        </button>
      </div>
    </motion.div>
  );
};

// 13. POLL/VOTE OVERLAY
const PollOverlay = ({ poll, onVote, userCoins }) => {
  if (!poll) return null;
  const totalVotes = poll.options.reduce((sum, opt) => sum + opt.votes, 0);

  return (
    <motion.div
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 100, opacity: 0 }}
      className="absolute bottom-80 left-4 right-4 z-25 bg-black/80 backdrop-blur-md rounded-3xl p-4 border border-white/20"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-bold flex items-center gap-2">
          <Target size={20} className="text-blue-400" />
          {poll.question}
        </h3>
        <div className="text-white/60 text-sm">{poll.duration}s</div>
      </div>
      <div className="space-y-2">
        {poll.options.map((option, idx) => {
          const percentage = totalVotes > 0 ? (option.votes / totalVotes) * 100 : 0;
          return (
            <button
              key={idx}
              onClick={() => onVote(poll.id, idx)}
              className="w-full relative"
            >
              <div className="bg-white/10 rounded-xl overflow-hidden border border-white/20 hover:border-blue-400 transition-colors">
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-blue-500/30 to-purple-500/30"
                  style={{ width: `${percentage}%` }}
                />
                <div className="relative px-4 py-3 flex items-center justify-between">
                  <span className="text-white font-medium">{option.text}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-white/60 text-sm">{option.votes}</span>
                    <span className="text-blue-400 font-bold">{percentage.toFixed(0)}%</span>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {poll.type === POLL_TYPES.COIN_WEIGHTED && (
        <div className="mt-3 text-center text-yellow-400 text-xs">
          💰 Votes weighted by coins spent
        </div>
      )}
    </motion.div>
  );
};

// 14. AR FILTER GALLERY
const ARFilterGallery = ({ isOpen, onClose, onSelectFilter, userCoins, activeFilters }) => {
  const [selectedCategory, setSelectedCategory] = useState('voice_activated');
  const [search, setSearch] = useState('');

  if (!isOpen) return null;

  const category = AR_FILTER_CATEGORIES[selectedCategory];
  const filters = category.filters.filter(f =>
    f.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-60 bg-black/95 backdrop-blur-sm">
      <div className="p-4 border-b border-white/10">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-white text-2xl font-black flex items-center gap-2">
            <Sparkles className="text-pink-500" />
            AR Filter Studio
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full">
            <X className="text-white" size={24} />
          </button>
        </div>
        <div className="relative">
          <input
            type="text"
            placeholder="Search filters..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-white/10 text-white rounded-full px-4 py-3 pl-12 focus:outline-none focus:ring-2 focus:ring-pink-500"
          />
          <Sparkles className="absolute left-4 top-3.5 text-white/60" size={20} />
        </div>
      </div>
      <div className="flex gap-2 p-4 overflow-x-auto border-b border-white/10">
        {Object.values(AR_FILTER_CATEGORIES).map(cat => (
          <button
            key={cat.id}
            onClick={() => setSelectedCategory(cat.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full whitespace-nowrap transition-all ${
              selectedCategory === cat.id
                ? 'text-white shadow-lg scale-105'
                : 'text-white/60 bg-white/5 hover:bg-white/10'
            }`}
            style={{ backgroundColor: selectedCategory === cat.id ? cat.color : undefined }}
          >
            <span className="text-xl">{cat.icon}</span>
            <span className="font-bold text-sm">{cat.name}</span>
          </button>
        ))}
      </div>
      <div className="px-4 py-3 bg-gradient-to-r from-purple-900/30 to-pink-900/30 border-b border-white/10">
        <p className="text-white/80 text-sm">{category.description}</p>
      </div>
      <div className="grid grid-cols-3 gap-3 p-4 overflow-y-auto h-[calc(100vh-300px)]">
        {filters.map(filter => {
          const isActive = activeFilters.some(f => f.id === filter.id);
          const canAfford = userCoins >= filter.cost;
          return (
            <button
              key={filter.id}
              onClick={() => canAfford && onSelectFilter(filter)}
              disabled={!canAfford && !isActive}
              className={`relative flex flex-col items-center p-4 rounded-2xl border-2 transition-all ${
                isActive
                  ? 'border-green-500 bg-green-500/20'
                  : canAfford
                    ? 'border-white/10 bg-gradient-to-b from-white/10 to-white/5 hover:border-pink-500 hover:scale-105'
                    : 'border-gray-700 bg-gray-800/50 opacity-50 cursor-not-allowed'
              }`}
            >
              {isActive && (
                <div className="absolute -top-2 -right-2 bg-green-500 text-white text-xs px-2 py-1 rounded-full font-bold">
                  ACTIVE
                </div>
              )}
              {filter.rarity && (
                <div className={`absolute -top-2 -left-2 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                  filter.rarity === 'legendary' ? 'bg-gradient-to-r from-yellow-500 to-orange-500' :
                  filter.rarity === 'epic' ? 'bg-gradient-to-r from-purple-500 to-pink-500' :
                  'bg-blue-500'
                } text-white`}>
                  {filter.rarity.toUpperCase()}
                </div>
              )}
              {filter.requiresZK && (
                <div className="absolute bottom-12 left-2 bg-purple-600 text-white text-[10px] px-2 py-0.5 rounded-full font-bold">
                  ZK
                </div>
              )}
              <span className="text-5xl mb-2">{filter.icon}</span>
              <span className="text-white text-sm font-bold text-center leading-tight mb-1">
                {filter.name}
              </span>
              <p className="text-white/60 text-[10px] text-center mb-2 line-clamp-2">
                {filter.description}
              </p>
              <div className="flex items-center gap-1">
                <Gem size={12} className="text-yellow-400" />
                <span className="text-yellow-400 font-bold text-sm">
                  {filter.cost === 0 ? 'FREE' : `$${filter.cost}`}
                </span>
              </div>
              <div className="flex gap-1 mt-2 flex-wrap justify-center">
                {filter.voiceTrigger && (
                  <span className="text-[8px] bg-pink-500 text-white px-1 py-0.5 rounded">
                    🎤 {filter.voiceTrigger}
                  </span>
                )}
                {filter.audioReactive && (
                  <span className="text-[8px] bg-blue-500 text-white px-1 py-0.5 rounded">
                    🎵 Audio
                  </span>
                )}
                {filter.nft && (
                  <span className="text-[8px] bg-yellow-500 text-white px-1 py-0.5 rounded">
                    NFT
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {activeFilters.length > 0 && (
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black via-gray-900 to-transparent border-t border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <Layers className="text-pink-500" size={16} />
            <span className="text-white font-bold text-sm">Active Filters ({activeFilters.length})</span>
          </div>
          <div className="flex gap-2 overflow-x-auto">
            {activeFilters.map(filter => (
              <div key={filter.id} className="flex items-center gap-2 bg-white/10 rounded-full px-3 py-1">
                <span>{filter.icon}</span>
                <span className="text-white text-xs font-bold">{filter.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// 15. VIEWER EARNINGS MODAL
const ViewerEarningsModal = ({ isOpen, onClose, earnings, earningsPerSecond, watchTime }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-60 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gradient-to-b from-gray-900 to-black w-full max-w-md rounded-3xl p-6 border border-green-400/30" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-white text-2xl font-black flex items-center gap-2">
            <DollarSign className="text-green-400" />
            Your Earnings
          </h2>
          <button onClick={onClose}>
            <X className="text-gray-400 hover:text-white" size={24} />
          </button>
        </div>
        <div className="bg-gradient-to-r from-green-600 to-emerald-600 rounded-2xl p-6 mb-6 text-center">
          <div className="text-white/80 text-sm mb-2">Total Earned</div>
          <div className="text-white text-5xl font-black mb-2">${earnings.toFixed(4)}</div>
          <div className="text-green-200 text-sm">+${earningsPerSecond.toFixed(6)}/sec</div>
        </div>
        <div className="space-y-4 mb-6">
          <div className="flex justify-between items-center">
            <span className="text-white/60 text-sm">Watch Time</span>
            <span className="text-white font-bold">{watchTime.toFixed(1)} hours</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-white/60 text-sm">Base Rate</span>
            <span className="text-white font-bold">$0.36/hour</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-white/60 text-sm">Loyalty Bonus</span>
            <span className="text-green-400 font-bold">x1.5</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-white/60 text-sm">Creator Match</span>
            <span className="text-blue-400 font-bold">+50%</span>
          </div>
        </div>
        <div className="p-4 bg-yellow-900/30 rounded-xl border border-yellow-500/30 mb-6">
          <div className="text-yellow-200 text-sm text-center">
            💡 Keep watching and engaging to earn more!
          </div>
        </div>
        <button
          disabled={earnings < 0.01}
          className={`w-full py-4 rounded-xl font-bold text-lg ${
            earnings >= 0.01
              ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white hover:scale-105'
              : 'bg-gray-700 text-gray-400 cursor-not-allowed'
          } transition-transform`}
        >
          {earnings >= 0.01 ? `Cash Out $${earnings.toFixed(2)}` : 'Min $0.01 to withdraw'}
        </button>
      </div>
    </div>
  );
};

// 16. END STREAM MODAL
const EndStreamModal = ({ isOpen, onClose, onSave, onRepost, onDiscard, stats }) => {
  if (!isOpen) return null;

  const topWatchers = Object.entries(stats.sessionWatchTime || {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([userId, time]) => ({ userId, time }));

  const topLikers = Object.entries(stats.sessionLikes || {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([userId, likes]) => ({ userId, likes }));

  return (
    <div className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-xl flex items-center justify-center p-4">
      <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} className="bg-gray-900 w-full max-w-3xl rounded-3xl overflow-hidden">
        <div className="p-6 border-b border-white/10">
          <h2 className="text-white text-3xl font-black">Stream Ended</h2>
        </div>
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white/5 rounded-2xl p-4">
              <div className="text-gray-400 text-sm">Duration</div>
              <div className="text-white text-2xl font-bold">{formatDuration(stats.duration)}</div>
            </div>
            <div className="bg-white/5 rounded-2xl p-4">
              <div className="text-gray-400 text-sm">Peak Viewers</div>
              <div className="text-white text-2xl font-bold">{stats.peakViewers}</div>
            </div>
            <div className="bg-white/5 rounded-2xl p-4">
              <div className="text-gray-400 text-sm">Total Likes</div>
              <div className="text-white text-2xl font-bold">{formatNumber(stats.totalLikes)}</div>
            </div>
            <div className="bg-white/5 rounded-2xl p-4">
              <div className="text-gray-400 text-sm">Revenue</div>
              <div className="text-green-400 text-2xl font-bold">${stats.totalRevenue}</div>
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-white/5 rounded-2xl p-4">
              <h3 className="text-white font-bold mb-3 flex items-center gap-2">
                <Clock size={16} />
                Top Watchers
              </h3>
              <div className="space-y-2">
                {topWatchers.map((w, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-white">User {w.userId.slice(0, 8)}</span>
                    <span className="text-gray-400">{formatDuration(w.time)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white/5 rounded-2xl p-4">
              <h3 className="text-white font-bold mb-3 flex items-center gap-2">
                <Heart size={16} />
                Top Likers
              </h3>
              <div className="space-y-2">
                {topLikers.map((l, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-white">User {l.userId.slice(0, 8)}</span>
                    <span className="text-pink-400">{formatNumber(l.likes)} likes</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <button onClick={onSave} className="bg-gradient-to-r from-blue-600 to-blue-700 text-white py-4 rounded-xl font-bold flex items-center justify-center gap-2">
              <Download size={20} />
              Save Recording
            </button>
            <button onClick={onRepost} className="bg-gradient-to-r from-purple-600 to-pink-600 text-white py-4 rounded-xl font-bold flex items-center justify-center gap-2">
              <Share2 size={20} />
              Repost
            </button>
            <button onClick={onDiscard} className="bg-gradient-to-r from-gray-600 to-gray-700 text-white py-4 rounded-xl font-bold flex items-center justify-center gap-2">
              <Trash2 size={20} />
              Discard
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

// 17. GIFT STORE MODAL (SIMPLE)
const GiftStoreModal = ({ isOpen, onClose, onSend, coins }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-xl flex items-center justify-center p-4">
      <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} className="bg-gray-900 w-full max-w-2xl rounded-t-3xl overflow-hidden">
        <div className="p-6 border-b border-white/10">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-white text-2xl font-black">Gift Store</h2>
              <p className="text-gray-400 text-sm">Balance: <span className="text-yellow-400 font-bold">${coins}</span></p>
            </div>
            <button onClick={onClose}>
              <X className="text-white" size={24} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 p-6 max-h-[70vh] overflow-y-auto">
          {GIFT_TYPES.map(gift => (
            <button
              key={gift.id}
              onClick={() => onSend(gift)}
              disabled={coins < gift.cost}
              className={`p-4 rounded-2xl border-2 transition-all ${
                coins < gift.cost ? 'opacity-40 border-gray-700' : 'border-white/10 hover:border-pink-500'
              }`}
            >
              <div className="text-5xl mb-2">{gift.icon}</div>
              <div className="flex items-center justify-center gap-1">
                <Gem size={12} className="text-yellow-400" />
                <span className="text-yellow-400 font-bold text-sm">${gift.cost}</span>
              </div>
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
};

// 18. GIFT STORE ULTIMATE
const GiftStoreUltimate = ({ isOpen, onClose, onSendGift, userCoins, userLevel, subscription }) => {
  const [selectedCategory, setSelectedCategory] = useState('basic');
  const [showBundles, setShowBundles] = useState(false);

  const availableGifts = useMemo(() => {
    return GIFT_TYPES.filter(gift => {
      if (gift.minLevel && userLevel < gift.minLevel) return false;
      return gift.category === selectedCategory;
    });
  }, [selectedCategory, userLevel]);

  const getPrice = (gift) => {
    if (subscription?.id === 'gold' && gift.category === 'premium') {
      return Math.floor(gift.cost * 0.8);
    }
    if (userLevel >= 6) {
      return Math.floor(gift.cost * 0.8);
    }
    return gift.cost;
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed inset-x-0 bottom-0 z-50 bg-gray-900 rounded-t-3xl overflow-hidden max-h-[85vh] flex flex-col"
        >
          <div className="bg-gradient-to-r from-gray-900 via-purple-900 to-pink-900 p-4 border-b border-white/10">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h3 className="text-white font-bold text-2xl flex items-center gap-2">
                  <Gift className="text-pink-500" />
                  Gift Store
                </h3>
                <p className="text-gray-300 text-sm mt-1">
                  Balance: <span className="text-yellow-400 font-bold">{formatCurrency(userCoins)}</span>
                </p>
              </div>
              <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full text-white">
                <X size={24} />
              </button>
            </div>
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setShowBundles(false)}
                className={`px-4 py-2 rounded-full font-bold text-sm ${
                  !showBundles ? 'bg-pink-500 text-white' : 'bg-white/10 text-white/60'
                }`}
              >
                Gifts
              </button>
              <button
                onClick={() => setShowBundles(true)}
                className={`px-4 py-2 rounded-full font-bold text-sm ${
                  showBundles ? 'bg-pink-500 text-white' : 'bg-white/10 text-white/60'
                }`}
              >
                Bundles
              </button>
            </div>
            {!showBundles && (
              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                {Object.values(GIFT_CATEGORIES).map(cat => (
                  <button
                    key={cat.id}
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all flex items-center gap-1 ${
                      selectedCategory === cat.id
                        ? 'text-white shadow-lg scale-105'
                        : 'text-gray-400 hover:text-white bg-white/5'
                    }`}
                    style={{ backgroundColor: selectedCategory === cat.id ? cat.color : undefined }}
                  >
                    <span>{cat.icon}</span>
                    <span>{cat.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {!showBundles ? (
              <>
                {selectedCategory === 'premium' && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-4 p-4 bg-gradient-to-r from-orange-500 via-red-500 to-pink-500 rounded-2xl text-white"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Zap size={20} className="animate-pulse" />
                        <span className="font-bold text-lg">FLASH SALE: 20% OFF!</span>
                      </div>
                      <div className="text-sm opacity-90">Ends in 3:45</div>
                    </div>
                  </motion.div>
                )}
                <div className="grid grid-cols-3 gap-3 mb-20">
                  {availableGifts.map((gift) => {
                    const price = getPrice(gift);
                    const discount = gift.cost !== price;
                    return (
                      <motion.button
                        key={gift.id}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={() => onSendGift(gift)}
                        disabled={userCoins < price}
                        className={`relative flex flex-col items-center p-4 rounded-2xl border-2 transition-all ${
                          userCoins < price
                            ? 'opacity-40 cursor-not-allowed border-gray-700 bg-gray-800'
                            : 'border-white/10 bg-gradient-to-b from-white/10 to-white/5 hover:border-pink-500 hover:shadow-lg hover:shadow-pink-500/20'
                        }`}
                      >
                        {gift.rarity !== 'common' && (
                          <div className={`absolute -top-2 -right-2 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                            gift.rarity === 'mythic' ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white' :
                            gift.rarity === 'legendary' ? 'bg-gradient-to-r from-purple-500 to-purple-700 text-white' :
                            gift.rarity === 'epic' ? 'bg-gradient-to-r from-orange-500 to-red-500 text-white' :
                            'bg-blue-500 text-white'
                          }`}>
                            {gift.rarity}
                          </div>
                        )}
                        {discount && (
                          <div className="absolute -top-2 -left-2 bg-green-500 text-white px-2 py-0.5 rounded-full text-[10px] font-bold">
                            -{Math.round((1 - price/gift.cost) * 100)}%
                          </div>
                        )}
                        <span className="text-5xl mb-2 filter drop-shadow-xl">{gift.icon}</span>
                        <span className="text-white text-sm font-bold text-center leading-tight mb-1">
                          {gift.name}
                        </span>
                        <div className="flex items-center gap-1">
                          <Gem size={12} className="text-yellow-400" />
                          {discount && (
                            <span className="text-gray-400 line-through text-xs">${gift.cost}</span>
                          )}
                          <span className="text-yellow-400 font-bold text-sm">${price}</span>
                        </div>
                        {gift.weight > 1 && (
                          <div className="mt-1 text-[10px] text-purple-400 flex items-center gap-1">
                            <TrendingUp size={10} />
                            +{gift.weight}x
                          </div>
                        )}
                        {gift.region && (
                          <div className="mt-1 text-[9px] text-gray-400 uppercase">
                            {gift.region}
                          </div>
                        )}
                      </motion.button>
                    );
                  })}
                </div>
                {selectedCategory === 'mystery' && (
                  <div className="mt-4 p-4 bg-gradient-to-r from-pink-900/50 to-purple-900/50 rounded-2xl border border-pink-500/30">
                    <div className="flex items-center gap-3 mb-2">
                      <Shuffle className="text-pink-400" size={24} />
                      <h4 className="text-white font-bold text-lg">Mystery Box</h4>
                    </div>
                    <p className="text-gray-300 text-sm">
                      Open a mystery box and receive a random gift worth $25 to $500!
                    </p>
                  </div>
                )}
                {selectedCategory === 'cultural' && (
                  <div className="mt-4 p-4 bg-gradient-to-r from-green-900/50 to-blue-900/50 rounded-2xl border border-green-500/30">
                    <div className="flex items-center gap-3 mb-2">
                      <Globe className="text-green-400" size={24} />
                      <h4 className="text-white font-bold text-lg">Cultural Collection</h4>
                    </div>
                    <p className="text-gray-300 text-sm">
                      Celebrate diversity! 5% supports cultural preservation. 🌍
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-3 mb-20">
                {[
                  { coins: 100, price: 0.99, bonus: 0, popular: false },
                  { coins: 500, price: 4.99, bonus: 100, popular: false },
                  { coins: 1200, price: 9.99, bonus: 300, popular: true },
                  { coins: 3000, price: 19.99, bonus: 1000, popular: false },
                  { coins: 10000, price: 49.99, bonus: 5000, popular: false }
                ].map((bundle, idx) => (
                  <motion.button
                    key={idx}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className={`w-full p-4 rounded-2xl border-2 transition-all ${
                      bundle.popular
                        ? 'bg-gradient-to-r from-yellow-600/20 to-orange-600/20 border-yellow-400'
                        : 'bg-white/5 border-white/10 hover:border-pink-500'
                    }`}
                  >
                    {bundle.popular && (
                      <div className="text-yellow-400 text-xs font-bold mb-2 uppercase tracking-wider">
                        ⭐ Best Value
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center">
                          <Gem className="text-white" size={24} />
                        </div>
                        <div className="text-left">
                          <div className="text-white font-bold text-lg">
                            {bundle.coins + bundle.bonus} Coins
                          </div>
                          {bundle.bonus > 0 && (
                            <div className="text-green-400 text-sm font-bold">
                              +{bundle.bonus} BONUS
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-2xl font-black text-white">
                          ${bundle.price}
                        </div>
                        {bundle.bonus > 0 && (
                          <div className="text-xs text-gray-400">
                            Save {Math.round((bundle.bonus / bundle.coins) * 100)}%
                          </div>
                        )}
                      </div>
                    </div>
                  </motion.button>
                ))}
                <div className="mt-6 p-4 bg-gradient-to-r from-purple-900/50 to-pink-900/50 rounded-2xl border-2 border-purple-400">
                  <div className="flex items-center gap-3 mb-2">
                    <PartyPopper className="text-purple-400" size={24} />
                    <h4 className="text-white font-bold">First Purchase Bonus!</h4>
                  </div>
                  <p className="text-gray-300 text-sm">
                    Get <span className="text-yellow-400 font-bold">100% EXTRA COINS</span> on your first purchase!
                  </p>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// 19. SUBSCRIPTION MODAL
const SubscriptionModal = ({ isOpen, onClose, onSubscribe, tiers }) => {
  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-60 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        className="bg-gradient-to-b from-gray-900 to-black w-full max-w-2xl rounded-3xl overflow-hidden border border-white/10"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-3xl font-black text-white flex items-center gap-2">
              <Crown className="text-yellow-400" />
              Become a VIP
            </h2>
            <button onClick={onClose} className="text-gray-400 hover:text-white">
              <X size={24} />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            {tiers.map(tier => (
              <motion.button
                key={tier.id}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => onSubscribe(tier)}
                className="relative bg-gradient-to-b from-white/10 to-white/5 rounded-2xl p-6 border-2 border-white/20 hover:border-yellow-400 transition-all"
              >
                {tier.id === 'gold' && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-yellow-500 to-orange-500 text-white px-3 py-1 rounded-full text-xs font-bold">
                    POPULAR
                  </div>
                )}
                <div className="text-6xl mb-3">{tier.icon}</div>
                <div className="text-white text-xl font-bold mb-2">{tier.name}</div>
                <div className="text-3xl font-black mb-4" style={{ color: tier.color }}>
                  ${tier.price}/mo
                </div>
                <div className="space-y-2 text-left">
                  {tier.benefits.map((benefit, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-white/80 text-sm">
                      <CheckCircle2 size={14} className="text-green-400 flex-shrink-0" />
                      <span>{benefit}</span>
                    </div>
                  ))}
                </div>
              </motion.button>
            ))}
          </div>
          <div className="text-center text-gray-400 text-sm">
            Cancel anytime • Instant activation • Secure payment
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

// 20. TIP MENU OVERLAY
const TipMenuOverlay = ({ isOpen, onClose, onSendTip, tipMenu }) => {
  const [customAmount, setCustomAmount] = useState('');
  const [selectedTip, setSelectedTip] = useState(null);

  if (!isOpen) return null;

  const handleTipSelect = (tip) => {
    if (tip.id === 'custom') {
      setSelectedTip(tip);
    } else {
      onSendTip(tip);
      onClose();
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-60 bg-black/80 backdrop-blur-sm flex items-end justify-center"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        className="bg-gray-900 w-full max-w-lg rounded-t-3xl p-6 border-t border-white/10"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-white font-bold text-xl flex items-center gap-2">
            <Coffee className="text-orange-400" />
            Quick Tips
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={24} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {tipMenu.map(tip => (
            <motion.button
              key={tip.id}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => handleTipSelect(tip)}
              className="bg-gradient-to-br from-white/10 to-white/5 rounded-2xl p-4 border-2 border-white/10 hover:border-orange-400 transition-all"
            >
              <div className="text-4xl mb-2">{tip.icon}</div>
              <div className="text-white font-bold text-sm mb-1">{tip.name}</div>
              {tip.amount > 0 && (
                <div className="text-orange-400 font-bold">${tip.amount}</div>
              )}
            </motion.button>
          ))}
        </div>
        {selectedTip?.id === 'custom' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 p-4 bg-white/5 rounded-2xl border border-white/10"
          >
            <input
              type="number"
              placeholder="Enter amount ($)"
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
              className="w-full bg-white/10 text-white rounded-xl px-4 py-3 mb-3 focus:outline-none focus:ring-2 focus:ring-orange-400"
            />
            <button
              onClick={() => {
                onSendTip({ ...selectedTip, amount: parseFloat(customAmount) });
                onClose();
              }}
              disabled={!customAmount || parseFloat(customAmount) <= 0}
              className="w-full bg-gradient-to-r from-orange-500 to-red-500 text-white font-bold py-3 rounded-xl disabled:opacity-50"
            >
              Send Tip
            </button>
          </motion.div>
        )}
      </motion.div>
    </motion.div>
  );
};

// 21. QUESTION QUEUE
const QuestionQueue = ({ questions, onAnswer, isCreator }) => {
  if (!isCreator || questions.length === 0) return null;

  return (
    <motion.div
      initial={{ x: 100 }}
      animate={{ x: 0 }}
      className="absolute top-40 right-4 z-25 bg-black/60 backdrop-blur-md rounded-2xl p-3 border border-white/10 max-w-xs"
    >
      <div className="flex items-center gap-2 mb-3 text-white">
        <MessageSquare size={16} />
        <span className="font-bold text-sm">Questions ({questions.length})</span>
      </div>
      <div className="space-y-2 max-h-60 overflow-y-auto">
        {questions.slice(0, 5).map((q, idx) => (
          <div key={q.id} className="bg-white/10 rounded-xl p-2">
            <div className="text-white text-xs font-bold mb-1">{q.username}</div>
            <div className="text-white/80 text-xs mb-2">{q.text}</div>
            <button
              onClick={() => onAnswer(q.id)}
              className="text-blue-400 text-xs font-bold hover:underline"
            >
              Answer
            </button>
          </div>
        ))}
      </div>
    </motion.div>
  );
};

// 22. SCHEDULED STREAM COUNTDOWN
const ScheduledStreamCountdown = ({ scheduledTime, streamTitle }) => {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      const scheduled = new Date(scheduledTime);
      const diff = scheduled - now;
      if (diff <= 0) {
        setTimeLeft('LIVE NOW!');
      } else {
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        setTimeLeft(`${hours}h ${minutes}m`);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [scheduledTime]);

  return (
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center z-30">
      <motion.div
        animate={{ scale: [1, 1.1, 1] }}
        transition={{ repeat: Infinity, duration: 2 }}
        className="text-white"
      >
        <Calendar className="w-20 h-20 mx-auto mb-4 text-blue-400" />
        <h2 className="text-3xl font-black mb-2">{streamTitle}</h2>
        <div className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-r from-pink-500 to-purple-500">
          {timeLeft}
        </div>
        <p className="text-white/60 mt-2">Get notified when we go live!</p>
        <button className="mt-4 px-6 py-3 bg-pink-500 text-white font-bold rounded-full hover:bg-pink-600 transition-colors flex items-center gap-2 mx-auto">
          <Bell size={20} />
          Set Reminder
        </button>
      </motion.div>
    </div>
  );
};

// 23. ACHIEVEMENT UNLOCK ANIMATION
const AchievementUnlock = ({ badge, onComplete }) => {
  useEffect(() => {
    const timer = setTimeout(onComplete, 4000);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <motion.div
      initial={{ scale: 0, rotate: -180, opacity: 0 }}
      animate={{ scale: 1, rotate: 0, opacity: 1 }}
      exit={{ scale: 0, rotate: 180, opacity: 0 }}
      transition={{ type: 'spring', damping: 10 }}
      className="fixed inset-0 z-70 flex items-center justify-center pointer-events-none"
    >
      <div className="bg-gradient-to-r from-purple-600 via-pink-600 to-orange-600 p-1 rounded-3xl">
        <div className="bg-gray-900 rounded-3xl p-8 text-center">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, ease: 'linear' }}
            className="text-8xl mb-4"
          >
            {badge.icon}
          </motion.div>
          <div className="text-white text-2xl font-black mb-2">Achievement Unlocked!</div>
          <div className="text-yellow-400 text-xl font-bold mb-1">{badge.name}</div>
          <div className="text-gray-300 text-sm">{badge.condition}</div>
          {badge.xp && (
            <div className="mt-4 text-green-400 font-bold">+{badge.xp} XP</div>
          )}
        </div>
      </div>
    </motion.div>
  );
};

// 24. MULTI-HOST SPLIT SCREEN
const MultiHostView = ({ hosts, mainHost }) => {
  if (hosts.length <= 1) return null;

  return (
    <div className="absolute top-20 right-4 z-25 space-y-2">
      {hosts.filter(h => h.id !== mainHost).slice(0, 3).map(host => (
        <motion.div
          key={host.id}
          initial={{ x: 100 }}
          animate={{ x: 0 }}
          className="w-32 h-48 rounded-2xl overflow-hidden border-2 border-white/20 bg-gray-800 relative"
        >
          <img src={host.avatar} alt={host.name} className="w-full h-full object-cover" />
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2">
            <div className="text-white text-xs font-bold truncate">{host.name}</div>
            <div className="flex items-center gap-1 text-white/60 text-[10px]">
              <Users size={10} />
              {formatNumber(host.viewers)}
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
};

// 25. SCREEN SHAKE EFFECT HOOK
function useScreenShake() {
  const [isShaking, setIsShaking] = useState(false);
  const shake = useCallback(() => {
    setIsShaking(true);
    setTimeout(() => setIsShaking(false), 500);
  }, []);
  return [isShaking, shake];
}

// 26. LANGUAGE SELECTOR
const LanguageSelector = ({ currentLang, onSelect, languages }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 bg-white/10 rounded-full text-white hover:bg-white/20 transition-colors"
      >
        <Languages size={20} />
      </button>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute top-12 right-0 bg-gray-900 rounded-2xl p-2 border border-white/10 shadow-xl min-w-[150px] max-h-60 overflow-y-auto"
        >
          {languages.map(lang => (
            <button
              key={lang}
              onClick={() => {
                onSelect(lang);
                setIsOpen(false);
              }}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                currentLang === lang
                  ? 'bg-pink-500 text-white font-bold'
                  : 'text-white/80 hover:bg-white/10'
              }`}
            >
              {lang}
            </button>
          ))}
        </motion.div>
      )}
    </div>
  );
};

// 27. ANALYTICS DASHBOARD
const AnalyticsDashboard = ({ isOpen, onClose, analytics }) => {
  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-60 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9 }}
        animate={{ scale: 1 }}
        className="bg-gray-900 w-full max-w-4xl rounded-3xl p-6 border border-white/10"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-white text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="text-green-400" />
            Stream Analytics
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={24} />
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white/5 rounded-2xl p-4 border border-white/10">
            <div className="text-gray-400 text-sm mb-1">Peak Viewers</div>
            <div className="text-white text-3xl font-bold">{formatNumber(analytics.peakViewers)}</div>
          </div>
          <div className="bg-white/5 rounded-2xl p-4 border border-white/10">
            <div className="text-gray-400 text-sm mb-1">Total Revenue</div>
            <div className="text-green-400 text-3xl font-bold">{formatCurrency(analytics.totalRevenue)}</div>
          </div>
          <div className="bg-white/5 rounded-2xl p-4 border border-white/10">
            <div className="text-gray-400 text-sm mb-1">Watch Time</div>
            <div className="text-white text-3xl font-bold">{Math.floor(analytics.watchTime / 60)}m</div>
          </div>
          <div className="bg-white/5 rounded-2xl p-4 border border-white/10">
            <div className="text-gray-400 text-sm mb-1">Engagement</div>
            <div className="text-purple-400 text-3xl font-bold">{analytics.engagementScore}%</div>
          </div>
        </div>
        <div className="bg-white/5 rounded-2xl p-6 border border-white/10">
          <h3 className="text-white font-bold mb-4">Viewer Timeline</h3>
          <div className="h-48 flex items-end justify-between gap-2">
            {[45, 78, 92, 88, 105, 98, 112, 95, 88, 101].map((height, idx) => (
              <div key={idx} className="flex-1 bg-gradient-to-t from-pink-500 to-purple-500 rounded-t-lg" style={{ height: `${height}%` }} />
            ))}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};
