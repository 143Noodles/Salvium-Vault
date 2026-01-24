import React, { useState } from 'react';
import { Card, Button, Input } from './UIComponents';
import { X, TrendingUp, Layers, ArrowUpRight } from './Icons';
import { formatSAL } from '../utils/format';

interface StakeModalProps {
  isOpen: boolean;
  onClose: () => void;
  balance: number;
}

const StakeModal: React.FC<StakeModalProps> = ({ isOpen, onClose, balance }) => {
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState('30'); // days

  if (!isOpen) return null;

  const estimatedApy = 12.5;
  const numericAmount = parseFloat(amount) || 0;
  const estimatedReturns = (numericAmount * (estimatedApy / 100) * (parseInt(duration) / 365)).toFixed(2);

  const handleMax = () => {
    setAmount((balance - 10).toString()); // Leave some for gas
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <Card className="w-full max-w-md relative" glow>
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 text-text-muted hover:text-white transition-colors"
        >
          <X size={20} />
        </button>

        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
             <div className="p-2 bg-accent-primary/10 rounded-lg text-accent-primary">
                <Layers size={24} />
             </div>
             <h2 className="text-xl font-bold text-white">Create New Stake</h2>
          </div>
          <p className="text-text-muted text-sm pl-11">Lock your SAL to earn network rewards.</p>
        </div>

        <div className="space-y-6">
          {/* Amount Input */}
          <div className="space-y-2">
             <div className="flex justify-between text-xs font-medium">
               <span className="text-text-secondary uppercase tracking-wider">Stake Amount</span>
               <span className="text-text-muted">Available: <span className="text-white font-mono">{formatSAL(balance)} SAL</span></span>
             </div>
             <div className="relative">
               <Input 
                 type="number" 
                 placeholder="0.00" 
                 className="pr-20 font-mono text-lg"
                 value={amount}
                 onChange={(e) => setAmount(e.target.value)}
                 autoFocus
               />
               <button 
                 onClick={handleMax}
                 className="absolute right-3 top-1/2 -translate-y-1/2 text-xs bg-accent-primary/20 text-accent-primary px-2 py-1 rounded hover:bg-accent-primary/30 transition-colors uppercase font-bold"
               >
                 Max
               </button>
             </div>
          </div>

          {/* Duration Selector */}
          <div className="space-y-2">
             <span className="text-xs text-text-secondary uppercase tracking-wider font-medium">Lock Duration</span>
             <div className="grid grid-cols-3 gap-2">
                {['30', '90', '180'].map((d) => (
                  <button
                    key={d}
                    onClick={() => setDuration(d)}
                    className={`py-2 rounded-xl text-sm font-medium border transition-all ${
                      duration === d 
                      ? 'bg-accent-primary text-white border-accent-primary shadow-lg shadow-accent-primary/20' 
                      : 'bg-white/5 text-text-secondary border-transparent hover:bg-white/10'
                    }`}
                  >
                    {d} Days
                  </button>
                ))}
             </div>
          </div>

          {/* Summary Card */}
          <div className="bg-bg-secondary/50 rounded-xl p-4 border border-border-color/50 space-y-3">
             <div className="flex justify-between items-center text-sm">
                <span className="text-text-muted">APY Rate</span>
                <span className="text-accent-success font-bold font-mono">{estimatedApy}%</span>
             </div>
             <div className="flex justify-between items-center text-sm">
                <span className="text-text-muted">Est. Rewards</span>
                <span className="text-accent-primary font-bold font-mono">+{estimatedReturns} SAL</span>
             </div>
             <div className="h-[1px] bg-white/5 w-full my-1"></div>
             <div className="flex justify-between items-center text-sm">
                <span className="text-text-secondary font-medium">Total Unlock</span>
                <span className="text-white font-bold font-mono">{formatSAL(numericAmount + parseFloat(estimatedReturns))} SAL</span>
             </div>
          </div>

          <Button className="w-full py-3 text-base" onClick={onClose}>
            Confirm Stake
            <ArrowUpRight size={18} className="ml-2" />
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default StakeModal;