// LiveGiftsSection.jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from './api';
import { 
  Wallet, History, Crown, Zap, Flame, TrendingUp, AlertCircle, Lock, X, 
  ArrowUpRight, ArrowDownLeft, Gift, Coins, PiggyBank, CreditCard, 
  Banknote, ChevronRight, Clock, CheckCircle2, Info, DollarSign, 
  Package, Users, Receipt, ArrowRightLeft, Calendar, Brain,
  Shield, ChevronDown, ChevronUp, PiggyBank as ReserveIcon,
  ShoppingBag, Store, Plus, Minus
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from './AuthProvider.jsx';
import { useTranslation } from "react-i18next";

const LiveGiftsSection = ({ showToast }) => {
  const { user, identity } = useAuth();
  const currentUser = user; 
  
  const [balances, setBalances] = useState({
    coins: currentUser?.coins || 0,
    earnings: currentUser?.earnings || 0, 
    reserved: currentUser?.reservedBalance || 0,
    flowers: currentUser?.giftInventory?.flowers || 0,
    diamonds: currentUser?.giftInventory?.diamonds || 0,
    rockets: currentUser?.giftInventory?.rockets || 0,
    crowns: currentUser?.giftInventory?.crowns || 0,
  });

  // Auto-withdraw with local state management
  const [autoWithdraw, setAutoWithdraw] = useState(currentUser?.autoWithdraw ?? false);
  const [autoWithdrawDay] = useState(currentUser?.autoWithdrawDay || 1);
  const [isToggling, setIsToggling] = useState(false);
  
  // Store
  const [showStore, setShowStore] = useState(false);
  const [storeTab, setStoreTab] = useState('coins');
  const [cart, setCart] = useState({});
  
  // Schedule
  const [scheduledGifts, setScheduledGifts] = useState([]);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({
    creatorId: '',
    giftId: '',
    message: '',
    deliveryTrigger: 'next_stream'
  });
  const [isScheduling, setIsScheduling] = useState(false);
  
  // Reserve
  const [showReserveModal, setShowReserveModal] = useState(false);
  const [reserveAmount, setReserveAmount] = useState('');
  
  // Withdrawal
  const [showWithdrawal, setShowWithdrawal] = useState(false);
  const [withdrawalAmount, setWithdrawalAmount] = useState('');
  const [withdrawalMethod, setWithdrawalMethod] = useState('orange_money');
  const [withdrawalHistory, setWithdrawalHistory] = useState([]);
  const [isProcessingWithdrawal, setIsProcessingWithdrawal] = useState(false);
  const MIN_WITHDRAWAL = 10;
  
  // Insights
  const [insights, setInsights] = useState({
    bestStreamingHours: [],
    optimalGiftAcknowledgmentTime: 10,
    projectedMonthlySpend: 0,
    spendingTrend: 'stable',
    taxEstimate: 0
  });
  
  const [transactions, setTransactions] = useState([]);
  const [activeTab, setActiveTab] = useState('wallet');
  const [creatorStats, setCreatorStats] = useState({
    totalReceived: 0, uniqueGifters: 0, topGifter: null, thisMonth: 0
  });

  const giftItems = [
    { id: 'flowers', name: 'Rose', icon: '🌹', price: 0.99, qty: 1, rarity: 'common', description: 'Classic gift for any occasion', bulk: [{ qty: 5, price: 3.99, save: '20%' }] },
    { id: 'diamonds', name: 'Diamond', icon: '💎', price: 4.99, qty: 1, rarity: 'rare', description: 'Premium gift for special moments', bulk: [{ qty: 3, price: 12.99, save: '15%' }] },
    { id: 'rockets', name: 'Rocket', icon: '🚀', price: 9.99, qty: 1, rarity: 'epic', description: 'Make a big impact', bulk: [{ qty: 2, price: 17.99, save: '10%' }] },
    { id: 'crowns', name: 'Crown', icon: '👑', price: 19.99, qty: 1, rarity: 'legendary', description: 'Ultimate recognition', bulk: [{ qty: 3, price: 49.99, save: '25%' }] }
  ];

  const coinPackages = [
    { id: 'starter', coins: 100, price: 0.99, bonus: 0, popular: false },
    { id: 'value', coins: 550, price: 4.49, bonus: 50, popular: true },
    { id: 'pro', coins: 1200, price: 8.99, bonus: 200, popular: false },
    { id: 'whale', coins: 5000, price: 34.99, bonus: 1000, popular: false, vip: true }
  ];

  useEffect(() => {
    fetchWalletData();
    fetchInsights();
    fetchScheduledGifts();
  }, []);

  const fetchWalletData = async () => {
    try {
      const response = await api.get('/payments/balance');
      if (response.data) {
        // Consolidate all balances in one object to prevent desync
        setBalances({
          coins: response.data.coins || 0,
          earnings: response.data.earnings || 0,
          reserved: response.data.reserved || 0,
          flowers: response.data.inventory?.flowers || 0,
          diamonds: response.data.inventory?.diamonds || 0,
          rockets: response.data.inventory?.rockets || 0,
          crowns: response.data.inventory?.crowns || 0,
        });
        setAutoWithdraw(response.data.autoWithdraw ?? false);
        setCreatorStats(response.data.creatorStats || {});
        setWithdrawalHistory(response.data.withdrawals || []);
      }
    } catch (error) {
      console.error('Failed to fetch wallet:', error);
    }
  };

  const fetchInsights = async () => {
    try {
      const response = await api.get('/analytics/insights');
      setInsights(response.data || {
        bestStreamingHours: ['20:00', '21:00'],
        optimalGiftAcknowledgmentTime: 10,
        projectedMonthlySpend: 450,
        spendingTrend: 'stable',
        taxEstimate: 63
      });
    } catch (error) {
      console.error('Failed to fetch insights:', error);
    }
  };

  const fetchScheduledGifts = async () => {
    try {
      const response = await api.post('/gifts/schedule');
      setScheduledGifts(response.data || []);
    } catch (error) {
      console.error('Failed to fetch scheduled gifts:', error);
    }
  };

  const addToCart = (itemId, qty, price, isCoin = false, coinAmount = null) => {
  const cartKey = isCoin ? `coins-${itemId}` : itemId;
  
  setCart(prev => {
    // Toggle behavior: if already selected, deselect
    if (prev[cartKey]) {
      const newCart = { ...prev };
      delete newCart[cartKey];
      return newCart;
    }
    
    const newCart = { ...prev };
    
    // If selecting a coin, remove other coins from cart (only one coin package at a time)
    if (isCoin) {
      Object.keys(newCart).forEach(key => {
        if (newCart[key].isCoin) delete newCart[key];
      });
    }
    
    newCart[cartKey] = { 
      qty, 
      price, 
      isCoin, 
      originalId: itemId,
      coinAmount // Store this for display only
    };
    return newCart;
  });
};

  const removeFromCart = (cartKey) => {
    setCart(prev => {
      const newCart = { ...prev };
      delete newCart[cartKey];
      return newCart;
    });
  };

const calculateCartTotal = () => {
  return Object.values(cart).reduce((total, item) => total + item.price, 0);
};

  // FIXED: Checkout properly updates coin balance
  const checkout = async () => {
    try {
      const items = Object.entries(cart).map(([key, data]) => ({
        itemId: data.isCoin ? 'coins' : data.originalId,
        packageId: data.isCoin ? data.originalId : null,
        quantity: data.qty,
        type: data.isCoin ? 'coins' : 'gift'
      }));

      await api.post('/store/purchase', { items });
      
      // Update balances locally based on cart contents
      setBalances(prev => {
        const newBalances = { ...prev };
        Object.entries(cart).forEach(([key, data]) => {
          if (data.isCoin) {
            newBalances.coins += data.qty; // Add coins to balance
          } else {
            newBalances[data.originalId] = (newBalances[data.originalId] || 0) + data.qty;
          }
        });
        return newBalances;
      });

      showToast('Purchase successful!', 'success');
      setCart({});
      setShowStore(false);
      
      // Refresh from server to ensure sync
      fetchWalletData();
      
    } catch (error) {
      showToast('Purchase failed', 'error');
    }
  };

  const calculateWithdrawalNet = (grossAmount, method) => {
    const platformFee = grossAmount * 0.30;
    const paymentFee = grossAmount * (method === 'bank_transfer' ? 0.05 : 0.02);
    const vat = (platformFee + paymentFee) * 0.14;
    const net = grossAmount - platformFee - paymentFee - vat;
    return { gross: grossAmount, platformFee, paymentFee, vat, net: Math.max(0, net) };
  };

  //Toggle with loading state and better error handling
  const toggleAutoWithdraw = async () => {
    if (isToggling) return;
    
    setIsToggling(true);
    const newState = !autoWithdraw;
    
    try {
      await api.patch('/wallet/settings', { autoWithdraw: newState, autoWithdrawDay  });
      setAutoWithdraw(newState);
      fetchWalletData();
      showToast(newState ? 'Auto-withdrawal enabled' : 'Auto-withdrawal disabled', 'success');
    } catch (error) {
      showToast('Failed to update settings', 'error');
      // Don't update state on error
    } finally {
      setIsToggling(false);
    }
  };

  const handleReserve = async (e) => {
    e.preventDefault();
    const amount = parseFloat(reserveAmount);
    const available = balances.earnings - balances.reserved;
    
    if (amount <= 0 || amount > available) {
      showToast('Invalid reserve amount', 'error');
      return;
    }
    
    try {
      await api.post('/wallet/reserve', { amount });
      setBalances(prev => ({ ...prev, reserved: prev.reserved + amount }));
      setReserveAmount('');
      setShowReserveModal(false);
      showToast(`Reserved $${amount}`, 'success');
      fetchWalletData();
    } catch (error) {
      showToast('Failed to reserve', 'error');
    }
  };

  const handleScheduleGift = async (e) => {
    e.preventDefault();
    
    if (!scheduleForm.giftId || !scheduleForm.creatorId) {
      showToast('Please select a gift and enter creator ID', 'error');
      return;
    }

    const gift = giftItems.find(g => g.id === scheduleForm.giftId);
    if (!gift) {
      showToast('Invalid gift selected', 'error');
      return;
    }

    const hasInInventory = balances[gift.id] > 0;
    const coinCost = Math.ceil(gift.price * 10); // $1 = 10 coins approx
    
    if (!hasInInventory && balances.coins < coinCost) {
      showToast(`Insufficient balance. Need ${coinCost} coins or 1 ${gift.name} in inventory.`, 'error');
      return;
    }

    setIsScheduling(true);
    
    try {
      await api.post('/gifts/schedule', {
        ...scheduleForm,
        useInventory: hasInInventory,
        cost: hasInInventory ? 0 : coinCost
      });
      
      // Update balances locally
      setBalances(prev => {
        const newBalances = { ...prev };
        if (hasInInventory) {
          newBalances[gift.id] -= 1;
        } else {
          newBalances.coins -= coinCost;
        }
        return newBalances;
      });
      
      showToast('Gift scheduled successfully!', 'success');
      setShowScheduleModal(false);
      setScheduleForm({
        creatorId: '',
        giftId: '',
        message: '',
        deliveryTrigger: 'next_stream'
      });
      
      fetchScheduledGifts();
    } catch (error) {
      showToast(error.response?.data?.message || 'Failed to schedule gift', 'error');
    } finally {
      setIsScheduling(false);
    }
  };

  const handleWithdrawal = async (e) => {
    e.preventDefault();
    const amount = parseFloat(withdrawalAmount);
    const available = balances.earnings - balances.reserved;
    
    if (amount < MIN_WITHDRAWAL) {
      showToast(`Minimum withdrawal is $${MIN_WITHDRAWAL}`, 'error');
      return;
    }
    
    if (amount > available) {
      showToast('Insufficient available balance', 'error');
      return;
    }
    
    setIsProcessingWithdrawal(true);
    
    try {
      await api.post('/wallet/withdraw', {
        amount: amount,
        method: withdrawalMethod
      });
      
      setBalances(prev => ({ ...prev, earnings: prev.earnings - amount }));
      setWithdrawalAmount('');
      setShowWithdrawal(false);
      showToast(`Withdrawal of $${amount} initiated!`, 'success');
      fetchWithdrawalHistory();
      
      const newTx = {
        id: Date.now(),
        type: 'withdrawal',
        amount: -amount,
        date: new Date().toISOString()
      };
      setTransactions(prev => [newTx, ...prev]);
      
    } catch (error) {
      showToast(error.response?.data?.message || 'Withdrawal failed', 'error');
    } finally {
      setIsProcessingWithdrawal(false);
    }
  };

  const SpendingCoachAlert = () => {
    if (insights.projectedMonthlySpend < 300) return null;
    const isHighSpender = insights.projectedMonthlySpend > 1000;
    
    return (
      <motion.div 
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className={`mb-4 p-3 rounded-lg border-l-4 ${isHighSpender ? 'bg-red-50 border-red-500' : 'bg-amber-50 border-amber-500'}`}
      >
        <div className="flex items-start gap-2">
          <AlertCircle className={`mt-0.5 ${isHighSpender ? 'text-red-600' : 'text-amber-600'}`} size={16} />
          <div className="flex-1">
            <p className={`text-sm font-medium ${isHighSpender ? 'text-red-900' : 'text-amber-900'}`}>
              Spending Insight
            </p>
            <p className={`text-xs mt-1 ${isHighSpender ? 'text-red-700' : 'text-amber-700'}`}>
              Projected spend: <strong>${insights.projectedMonthlySpend}</strong> this month.
              {isHighSpender ? " Top 5% spender." : " Consider budgeting?"}
            </p>
          </div>
        </div>
      </motion.div>
    );
  };

  const preview = withdrawalAmount ? calculateWithdrawalNet(parseFloat(withdrawalAmount), withdrawalMethod) : null;
  const availableForWithdrawal = balances.earnings - balances.reserved;
  const canWithdraw = availableForWithdrawal >= MIN_WITHDRAWAL;

  return (
    <div className="mt-6 bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden">
      
      {/* INVENTORY BAR - Shows all assets */}
      <div className="bg-gray-900 p-3 flex items-center justify-between overflow-x-auto scrollbar-hide">
        <div className="flex items-center gap-3 min-w-max px-2">
          <div className="flex items-center gap-1 bg-white/10 px-3 py-1.5 rounded-full">
            <span className="text-lg">🌹</span>
            <span className="text-white font-bold text-sm">({balances.flowers || 0})</span>
          </div>
          <div className="flex items-center gap-1 bg-white/10 px-3 py-1.5 rounded-full">
            <span className="text-lg">💎</span>
            <span className="text-white font-bold text-sm">({balances.diamonds || 0})</span>
          </div>
          <div className="flex items-center gap-1 bg-white/10 px-3 py-1.5 rounded-full">
            <span className="text-lg">🚀</span>
            <span className="text-white font-bold text-sm">({balances.rockets || 0})</span>
          </div>
          <div className="flex items-center gap-1 bg-white/10 px-3 py-1.5 rounded-full">
            <span className="text-lg">👑</span>
            <span className="text-white font-bold text-sm">({balances.crowns || 0})</span>
          </div>
          <div className="h-6 w-px bg-white/20 mx-1" />
          <div className="flex items-center gap-1 bg-yellow-500/20 px-3 py-1.5 rounded-full border border-yellow-500/30">
            <Coins size={14} className="text-yellow-400" />
            <span className="text-yellow-400 font-bold text-sm">({balances.coins || 0})</span>
          </div>
        </div>
        
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => setShowStore(true)}
          className="flex items-center gap-2 bg-gradient-to-r from-pink-500 to-purple-500 text-white px-4 py-2 rounded-full font-bold text-sm shadow-lg ml-2 flex-shrink-0"
        >
          <Store size={16} />
          Store
        </motion.button>
      </div>

      {/* MAIN CARD */}
      <div className="bg-gradient-to-br from-gray-800 to-gray-900 p-4 text-white">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="font-bold text-lg flex items-center gap-2">
              <Wallet className="text-yellow-400" size={20} />
              Creator Wallet
            </h3>
            <p className="text-gray-400 text-xs">Manage earnings & assets</p>
          </div>
          {canWithdraw && (
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={() => setShowWithdrawal(true)}
              className="bg-green-500 hover:bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1"
            >
              <ArrowUpRight size={14} />
              Withdraw
            </motion.button>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white/10 backdrop-blur rounded-xl p-3 border border-white/20">
            <div className="text-gray-400 text-xs mb-1">Available</div>
            <div className="text-xl font-bold text-green-400">
              ${availableForWithdrawal.toFixed(2)}
            </div>
          </div>
          <div className="bg-white/10 backdrop-blur rounded-xl p-3 border border-white/20">
            <div className="text-gray-400 text-xs mb-1">Reserved</div>
            <div className="text-xl font-bold text-purple-400">
              ${balances.reserved.toFixed(2)}
            </div>
          </div>
          <div className="bg-white/10 backdrop-blur rounded-xl p-3 border border-white/20">
            <div className="text-gray-400 text-xs mb-1">Earnings</div>
            <div className="text-xl font-bold text-yellow-400">
              ${balances.earnings.toFixed(2)}
            </div>
          </div>
        </div>

        {/* FIXED: Auto-withdraw toggle with loading state */}
        <div className="mt-3 flex items-center justify-between bg-white/5 rounded-lg p-3 border border-white/10">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full transition-colors ${autoWithdraw ? 'bg-green-400' : 'bg-gray-400'}`} />
            <span className="text-xs text-gray-300">
              Auto-withdraw on {autoWithdrawDay}st of month
            </span>
          </div>
          <button 
            onClick={toggleAutoWithdraw}
            disabled={isToggling}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-gray-800 ${autoWithdraw ? 'bg-green-600' : 'bg-gray-600'} ${isToggling ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${autoWithdraw ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </div>

      <SpendingCoachAlert />

      {/* NAVIGATION */}
      <div className="flex border-b border-gray-100 overflow-x-auto scrollbar-hide">
        {[
          { id: 'wallet', label: 'Wallet', icon: Wallet },
          { id: 'earnings', label: 'Earnings', icon: Brain },
          { id: 'scheduled', label: `Scheduled (${scheduledGifts.length})`, icon: Calendar },
          { id: 'history', label: 'History', icon: Receipt }
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-3 px-4 text-xs font-bold flex flex-col items-center gap-1 transition-colors min-w-[80px] ${activeTab === tab.id ? 'text-gray-900 border-b-2 border-[#FE2C55] bg-gray-50' : 'text-gray-500 hover:text-gray-700'}`}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* CONTENT */}
      <div className="p-4 max-h-[500px] overflow-y-auto">
        
        {/* WALLET TAB */}
        {activeTab === 'wallet' && (
          <div className="space-y-4">
            <button onClick={() => setShowStore(true)} className="w-full py-3 bg-gradient-to-r from-pink-500 to-purple-500 text-white rounded-xl font-bold flex items-center justify-center gap-2 shadow-lg">
              <ShoppingBag size={20} />
              Open Store
            </button>
            
            <div className="bg-blue-50 p-4 rounded-xl border border-blue-200">
              <h4 className="font-bold text-blue-900 mb-2">Your Assets</h4>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-600">Total Gifts:</span>
                  <div className="font-bold text-lg">
                    {(balances.flowers || 0) + (balances.diamonds || 0) + (balances.rockets || 0) + (balances.crowns || 0)}
                  </div>
                </div>
                <div>
                  <span className="text-gray-600">Coin Value:</span>
                  <div className="font-bold text-lg">${(balances.coins * 0.0099).toFixed(2)}</div>
                </div>
              </div>
            </div>

            {scheduledGifts.length > 0 && (
              <div className="bg-purple-50 p-3 rounded-lg text-sm">
                <p className="text-purple-800">You have {scheduledGifts.length} scheduled gifts pending</p>
              </div>
            )}
          </div>
        )}

        {/* EARNINGS TAB */}
        {activeTab === 'earnings' && (
          <div className="space-y-4">
            <button onClick={() => setShowWithdrawal(true)} disabled={!canWithdraw} className={`w-full py-4 rounded-xl font-bold flex items-center justify-center gap-2 ${canWithdraw ? 'bg-green-600 text-white' : 'bg-gray-200 text-gray-400'}`}>
              <Banknote size={20} />
              {canWithdraw ? `Withdraw $${availableForWithdrawal.toFixed(2)}` : `Need $${MIN_WITHDRAWAL} min`}
            </button>

            <div className="bg-indigo-50 rounded-xl p-4 border border-indigo-200">
              <h4 className="font-bold text-indigo-900 mb-3 flex items-center gap-2"><Brain size={18} /> Insights</h4>
              <div className="space-y-2 text-sm">
                <p>Best streaming: <strong>{insights.bestStreamingHours[0] || '20:00'}</strong></p>
                <p>Tax estimate: <strong>${insights.taxEstimate}</strong></p>
              </div>
            </div>

            <div className="bg-purple-50 rounded-xl p-4 border border-purple-200">
              <h4 className="font-bold text-purple-900 mb-2">Protected Reserve</h4>
              <p className="text-xs text-purple-700 mb-3">Protect earnings from accidental spending</p>
              <div className="flex gap-2">
                <button onClick={() => setShowReserveModal(true)} className="flex-1 py-2 bg-purple-600 text-white rounded-lg text-sm font-bold">
                  Add Reserve
                </button>
                {balances.reserved > 0 && (
                  <button onClick={async () => { 
                    await api.post('/wallet/unreserve', { amount: balances.reserved }); 
                    fetchWalletData(); 
                    showToast('Released', 'success'); 
                  }} className="flex-1 py-2 bg-white border border-purple-300 text-purple-700 rounded-lg text-sm">
                    Release All
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* SCHEDULED TAB */}
        {activeTab === 'scheduled' && (
          <div className="space-y-3">
            <button onClick={() => setShowScheduleModal(true)} className="w-full py-3 bg-purple-600 text-white rounded-xl font-bold flex items-center justify-center gap-2">
              <Calendar size={18} />
              Schedule New Gift
            </button>
            {scheduledGifts.length === 0 ? (
              <div className="text-center py-8 text-gray-400">
                <Calendar size={48} className="mx-auto mb-2 opacity-30" />
                <p>No scheduled gifts</p>
              </div>
            ) : (
              scheduledGifts.map((gift) => (
                <div key={gift.id} className="p-4 bg-gray-50 rounded-xl border border-gray-200 flex justify-between items-center">
                  <div>
                    <div className="text-2xl mb-1">{gift.giftIcon}</div>
                    <div className="font-bold text-gray-900">{gift.giftName}</div>
                    <div className="text-xs text-gray-500">To: {gift.creatorName}</div>
                    <div className="text-xs text-purple-600 mt-1">{gift.status === 'pending' ? '⏳ Pending next stream' : '✓ Delivered'}</div>
                  </div>
                  <div className="text-right">
                    {gift.status === 'pending' && (
                      <button onClick={async () => { 
                        await api.delete(`/gifts/scheduled/${gift.id}`); 
                        fetchScheduledGifts(); 
                        showToast('Cancelled', 'success'); 
                      }} className="text-xs text-red-600 font-medium">
                        {t("common.cancel")}
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* HISTORY TAB */}
        {activeTab === 'history' && (
          <div className="space-y-2">
            {transactions.length === 0 ? (
              <div className="text-center py-8 text-gray-400">No transactions yet</div>
            ) : (
              transactions.map((tx) => (
                <div key={tx.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${tx.type === 'purchase' ? 'bg-green-100 text-green-600' : tx.type === 'withdrawal' ? 'bg-red-100 text-red-600' : 'bg-gray-200'}`}>
                      {tx.type === 'purchase' ? <ArrowDownLeft size={18} /> : tx.type === 'withdrawal' ? <ArrowUpRight size={18} /> : <History size={18} />}
                    </div>
                    <div>
                      <div className="font-medium text-sm capitalize">{tx.type}</div>
                      <div className="text-xs text-gray-500">{new Date(tx.date).toLocaleDateString()}</div>
                    </div>
                  </div>
                  <div className={`font-bold ${tx.amount > 0 ? 'text-green-600' : 'text-gray-900'}`}>
                    {tx.amount > 0 ? '+' : ''}${Math.abs(tx.amount)}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* STORE MODAL */}
      <AnimatePresence>
        {showStore && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} exit={{ scale: 0.9 }} className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
              <div className="sticky top-0 bg-white border-b p-4 flex justify-between items-center z-10">
                <h3 className="font-bold text-xl flex items-center gap-2"><Store className="text-purple-600" /> Gift Store</h3>
                <button onClick={() => { setShowStore(false); setCart({}); }} className="p-2 hover:bg-gray-100 rounded-full"><X size={24} /></button>
              </div>

              <div className="p-4">
                <div className="flex gap-2 mb-6 bg-gray-100 p-1 rounded-lg">
                  <button onClick={() => setStoreTab('coins')} className={`flex-1 py-2 rounded-md text-sm font-bold transition-all ${storeTab === 'coins' ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}>
                    🪙 Buy Coins
                  </button>
                  <button onClick={() => setStoreTab('gifts')} className={`flex-1 py-2 rounded-md text-sm font-bold transition-all ${storeTab === 'gifts' ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}>
                    🎁 Buy Gifts
                  </button>
                </div>

                {/* COINS TAB */}
                {storeTab === 'coins' && (
                  <div className="space-y-3">
                    <div className="bg-blue-50 p-3 rounded-lg text-sm text-blue-800 mb-4">
                      Select one package. Click again to deselect.
                    </div>
                    {coinPackages.map((pkg) => {
                      const cartKey = `coins-${pkg.id}`;
                      const isSelected = !!cart[cartKey];
                      
                      return (
                        <motion.div
                          key={pkg.id}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => addToCart(pkg.id, 1, pkg.price, true, pkg.coins + pkg.bonus)}
                          className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${isSelected ? 'border-green-400 bg-green-50' : 'border-gray-200 hover:border-blue-400'}`}
                        >
                          <div className="flex justify-between items-center">
                            <div className="flex items-center gap-3">
                              <span className="text-3xl">🪙</span>
                              <div>
                                <div className="font-bold text-gray-900 text-lg">
                                  {pkg.coins.toLocaleString()} Coins
                                  {pkg.bonus > 0 && <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">+{pkg.bonus} FREE</span>}
                                </div>
                                {pkg.popular && <div className="text-xs text-orange-600 font-bold">POPULAR</div>}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-xl font-bold text-gray-900">${pkg.price}</div>
                              {isSelected && <div className="text-sm text-green-700 font-bold">✓ Selected</div>}
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                )}

                {/* GIFTS TAB */}
                {storeTab === 'gifts' && (
                  <div className="space-y-4">
                    <div className="bg-pink-50 p-3 rounded-lg text-sm text-pink-800">
                      Buy gifts directly to your inventory. Use anytime without spending coins.
                    </div>
                   {giftItems.map((item) => {
                const isSelected = !!cart[item.id];
                const currentQty = cart[item.id]?.qty || 0;
                
                return (
                    <div 
                    key={item.id} 
                    className={`bg-white border-2 rounded-xl p-4 transition-all ${
                        isSelected ? 'border-green-400 bg-green-50/30' : 'border-gray-100 hover:border-pink-300'
                    }`}
                    >
                    {/* Header */}
                    <div className="flex justify-between items-start mb-3">
                        <div className="flex items-center gap-3">
                        <span className="text-4xl">{item.icon}</span>
                        <div>
                            <div className="font-bold text-gray-900 text-lg flex items-center gap-2">
                            {item.name}
                            <span className={`text-xs px-2 py-1 rounded-full ${
                                item.rarity === 'legendary' ? 'bg-yellow-100 text-yellow-800' : 
                                item.rarity === 'epic' ? 'bg-purple-100 text-purple-800' : 
                                item.rarity === 'rare' ? 'bg-blue-100 text-blue-800' : 
                                'bg-gray-100 text-gray-800'
                            }`}>
                                {item.rarity}
                            </span>
                            </div>
                            <div className="text-sm text-gray-600">{item.description}</div>
                            <div className="text-lg font-bold text-gray-900 mt-1">${item.price}</div>
                        </div>
                        </div>
                    </div>

                    {/* Purchase Options */}
                    <div className="grid grid-cols-2 gap-2">
                        {/* Single */}
                        <button
                        onClick={() => addToCart(item.id, 1, item.price)}
                        className={`p-2 rounded-lg border text-sm text-center transition-all ${
                            currentQty === 1 
                            ? 'border-green-400 bg-green-50 ring-2 ring-green-200' 
                            : 'border-gray-200 hover:border-green-300 hover:bg-gray-50'
                        }`}
                        >
                        <div className="font-bold">1x</div>
                        <div className="text-xs text-gray-500">${item.price}</div>
                        </button>
                        
                        {/* Bulk Options */}
                        {item.bulk.map((deal, idx) => (
                        <button
                            key={idx}
                            onClick={() => addToCart(item.id, deal.qty, deal.price)}
                            className={`p-2 rounded-lg border text-sm text-center transition-all ${
                            currentQty === deal.qty 
                                ? 'border-green-400 bg-green-50 ring-2 ring-green-200' 
                                : 'border-gray-200 hover:border-green-300 hover:bg-gray-50'
                            }`}
                        >
                            <div className="font-bold">{deal.qty}x</div>
                            <div className="text-xs">
                            <span className="text-gray-500">${deal.price}</span>
                            <span className="text-green-600 font-bold ml-1">Save {deal.save}</span>
                            </div>
                        </button>
                        ))}
                    </div>

                    {/* Cart Status */}
                    {isSelected && (
                        <div className="mt-3 p-2 bg-green-100 rounded-lg flex justify-between items-center animate-in fade-in slide-in-from-top-2">
                      <span className="text-green-800 font-medium text-sm">
                        {currentQty} in cart • ${cart[item.id].price.toFixed(2)}
                        </span>
                        <button 
                            onClick={(e) => { 
                            e.stopPropagation(); 
                            removeFromCart(item.id); 
                            }} 
                            className="text-red-600 text-sm font-bold hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors"
                        >
                            Remove
                        </button>
                        </div>
                    )}
                    </div>
                );
                })}
                </div>
                                )}

                {/* CART SUMMARY */}
                {Object.keys(cart).length > 0 && (
                  <div className="sticky bottom-0 bg-white border-t mt-6 pt-4 pb-2">
                    <div className="flex justify-between items-center mb-3">
                      <span className="font-bold text-gray-700">Total:</span>
                      <span className="text-2xl font-bold text-gray-900">${calculateCartTotal().toFixed(2)}</span>
                    </div>
                    <button onClick={checkout} className="w-full py-4 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-bold text-lg shadow-lg">
                      Complete Purchase
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* WITHDRAWAL MODAL */}
      <AnimatePresence>
        {showWithdrawal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-lg">Withdraw Funds</h3>
                <button onClick={() => setShowWithdrawal(false)}><X size={24} /></button>
              </div>
              
              <div className="bg-green-50 p-4 rounded-xl mb-4 text-center border border-green-200">
                <div className="text-sm text-green-700">Available (minus reserves)</div>
                <div className="text-3xl font-bold text-green-900">${availableForWithdrawal.toFixed(2)}</div>
              </div>

              <form onSubmit={handleWithdrawal}>
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount ($)</label>
                  <input 
                    type="number" 
                    min={MIN_WITHDRAWAL} 
                    max={availableForWithdrawal} 
                    step="0.01" 
                    value={withdrawalAmount} 
                    onChange={(e) => setWithdrawalAmount(e.target.value)} 
                    className="w-full p-3 border rounded-lg focus:ring-2 focus:ring-green-500" 
                    placeholder={`Min $${MIN_WITHDRAWAL}`} 
                    required 
                  />
                </div>

                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Method</label>
                  <div className="space-y-2">
                    {[
                      {id: 'orange_money', label: 'Orange Money', fee: '2%'}, 
                      {id: 'mtn_money', label: 'MTN Mobile Money', fee: '2%'}, 
                      {id: 'bank_transfer', label: 'Bank Transfer', fee: '5%'}
                    ].map((method) => (
                      <div 
                        key={method.id} 
                        onClick={() => setWithdrawalMethod(method.id)} 
                        className={`p-3 rounded-lg border-2 cursor-pointer flex justify-between items-center ${withdrawalMethod === method.id ? 'border-green-500 bg-green-50' : 'border-gray-200'}`}
                      >
                        <div>
                          <div className="font-medium">{method.label}</div>
                          <div className="text-xs text-gray-500">Fee: {method.fee}</div>
                        </div>
                        {withdrawalMethod === method.id && <CheckCircle2 className="text-green-600" size={20} />}
                      </div>
                    ))}
                  </div>
                </div>

                {preview && (
                  <div className="bg-gray-50 p-3 rounded-lg space-y-2 text-sm mb-4 border-2 border-gray-200">
                    <div className="flex justify-between"><span>Gross</span><span>${preview.gross.toFixed(2)}</span></div>
                    <div className="flex justify-between text-red-600"><span>Platform (30%)</span><span>-${preview.platformFee.toFixed(2)}</span></div>
                    <div className="flex justify-between text-red-600"><span>Fee</span><span>-${preview.paymentFee.toFixed(2)}</span></div>
                    <div className="flex justify-between text-red-600"><span>VAT (14%)</span><span>-${preview.vat.toFixed(2)}</span></div>
                    <div className="border-t pt-2 flex justify-between font-bold text-lg text-green-700">
                      <span>Net</span><span>${preview.net.toFixed(2)}</span>
                    </div>
                  </div>
                )}

                <button 
                  type="submit" 
                  disabled={isProcessingWithdrawal || !preview || preview.net <= 0} 
                  className="w-full py-4 bg-green-600 text-white rounded-xl font-bold disabled:bg-gray-300"
                >
                  {isProcessingWithdrawal ? 'Processing...' : `Withdraw $${preview?.net.toFixed(2) || '0.00'}`}
                </button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* RESERVE MODAL */}
      <AnimatePresence>
        {showReserveModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl w-full max-w-sm p-6">
              <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                <ReserveIcon className="text-purple-600" /> 
                Reserve Funds
              </h3>
              <div className="bg-purple-50 p-3 rounded-lg mb-4 text-center">
                <div className="text-xs text-purple-600">Available to reserve</div>
                <div className="text-2xl font-bold text-purple-900">${(balances.earnings - balances.reserved).toFixed(2)}</div>
              </div>
              <form onSubmit={handleReserve}>
                <input 
                  type="number" 
                  step="0.01" 
                  max={balances.earnings - balances.reserved} 
                  value={reserveAmount} 
                  onChange={(e) => setReserveAmount(e.target.value)} 
                  className="w-full p-3 border rounded-lg mb-4" 
                  placeholder="Amount to reserve" 
                  required 
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => setShowReserveModal(false)} className="flex-1 py-2 border border-gray-300 rounded-lg">
                    {t("common.cancel")}
                  </button>
                  <button type="submit" className="flex-1 py-2 bg-purple-600 text-white rounded-lg font-bold">
                    Reserve
                  </button>
                </div>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SCHEDULE MODAL */}
      <AnimatePresence>
        {showScheduleModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-lg flex items-center gap-2">
                  <Calendar className="text-purple-600" /> 
                  Schedule Gift
                </h3>
                <button onClick={() => setShowScheduleModal(false)} className="p-1 hover:bg-gray-100 rounded-full">
                  <X size={20} />
                </button>
              </div>
              
              <form onSubmit={handleScheduleGift} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Select Gift *</label>
                  <select 
                    value={scheduleForm.giftId} 
                    onChange={(e) => setScheduleForm({...scheduleForm, giftId: e.target.value})} 
                    className="w-full p-3 border rounded-lg focus:ring-2 focus:ring-purple-500" 
                    required
                  >
                    <option value="">Choose a gift...</option>
                    {giftItems.map(g => (
                      <option key={g.id} value={g.id}>
                        {g.icon} {g.name} (${g.price}) - You have: {balances[g.id] || 0}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Creator Username *</label>
                  <input 
                    type="text" 
                    value={scheduleForm.creatorId} 
                    onChange={(e) => setScheduleForm({...scheduleForm, creatorId: e.target.value})} 
                    className="w-full p-3 border rounded-lg focus:ring-2 focus:ring-purple-500" 
                    placeholder="@username" 
                    required 
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Delivery Timing</label>
                  <select 
                    value={scheduleForm.deliveryTrigger} 
                    onChange={(e) => setScheduleForm({...scheduleForm, deliveryTrigger: e.target.value})} 
                    className="w-full p-3 border rounded-lg"
                  >
                    <option value="next_stream">Next time they go live</option>
                    <option value="specific_date">Specific date (coming soon)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Message (optional)</label>
                  <textarea 
                    value={scheduleForm.message} 
                    onChange={(e) => setScheduleForm({...scheduleForm, message: e.target.value})} 
                    className="w-full p-3 border rounded-lg focus:ring-2 focus:ring-purple-500" 
                    rows="2" 
                    placeholder="Hey! Can't wait for your stream!" 
                  />
                </div>

                <div className="bg-yellow-50 p-3 rounded-lg text-sm text-yellow-800">
                  <Info size={14} className="inline mr-1" />
                  You have {balances.coins} coins. Gifts in inventory are used first.
                </div>

                <div className="flex gap-3 pt-2">
                  <button 
                    type="button" 
                    onClick={() => setShowScheduleModal(false)} 
                    className="flex-1 py-3 border border-gray-300 rounded-xl font-medium text-gray-700"
                  >
                    {t("common.cancel")}
                  </button>
                  <button 
                    type="submit" 
                    disabled={isScheduling || !scheduleForm.giftId || !scheduleForm.creatorId} 
                    className="flex-1 py-3 bg-purple-600 text-white rounded-xl font-bold disabled:bg-gray-300 disabled:cursor-not-allowed"
                  >
                    {isScheduling ? 'Scheduling...' : 'Schedule Gift'}
                  </button>
                </div>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
};

export default LiveGiftsSection;