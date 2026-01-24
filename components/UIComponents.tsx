import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { isMobile, isTablet, isIPad13 } from 'react-device-detect';
import { X } from './Icons';

// Device detection helpers for responsive layouts (matching other components)
const isTabletDevice = isTablet || isIPad13;
const isMobileOrTablet = isMobile || isTabletDevice;

interface CardProps {
  children: React.ReactNode;
  className?: string;
  noPadding?: boolean;
  glow?: boolean;
  style?: React.CSSProperties;
}

export const Card: React.FC<CardProps> = ({ children, className = '', noPadding = false, glow = false, style }) => {
  return (
    <div
      className={`
      glass-panel rounded-2xl relative overflow-hidden transition-all duration-300
      ${glow ? 'shadow-lg shadow-black/40' : 'hover:border-white/10'}
      ${noPadding ? '' : 'p-6'} 
      ${className}
    `}
      style={style}
    >
      {children}
    </div>
  );
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'icon' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...props
}) => {
  const baseStyles = "inline-flex items-center justify-center font-medium transition-all duration-300 rounded-xl focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed";

  const variants = {
    primary: "bg-accent-primary text-white shadow-lg shadow-accent-primary/20 hover:shadow-accent-primary/30 hover:-translate-y-0.5 border border-transparent",
    secondary: "bg-white/5 text-text-primary border border-white/10 hover:bg-white/10 hover:border-white/20",
    ghost: "bg-transparent text-text-secondary hover:text-white hover:bg-white/5",
    icon: "bg-white/5 text-text-secondary border border-white/10 hover:text-white hover:border-white/20 hover:bg-white/10 aspect-square",
    danger: "bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/40"
  };

  const sizes = {
    sm: "px-3 py-1.5 text-xs",
    md: "px-5 py-2.5 text-sm",
    lg: "px-8 py-4 text-base"
  };

  const sizeStyles = variant === 'icon' ? (size === 'sm' ? 'p-1.5' : size === 'lg' ? 'p-4' : 'p-2.5') : sizes[size];

  return (
    <button
      className={`${baseStyles} ${variants[variant]} ${sizeStyles} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'success' | 'warning' | 'neutral' | 'accent';
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({ children, variant = 'neutral', className = '' }) => {
  const styles = {
    success: "text-accent-success bg-accent-success/10 border-accent-success/20",
    warning: "text-accent-warning bg-accent-warning/10 border-accent-warning/20",
    neutral: "text-text-secondary bg-white/5 border-white/10",
    accent: "text-accent-primary bg-accent-primary/10 border-accent-primary/20"
  };

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium border ${styles[variant]} ${className}`}>
      {children}
    </span>
  );
};

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className = '', ...props }, ref) => (
  <input
    ref={ref}
    className={`w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-text-muted focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/50 transition-all ${className}`}
    {...props}
  />
));
Input.displayName = 'Input';

export const TextArea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className = '', ...props }, ref) => (
  <textarea
    ref={ref}
    className={`w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-text-muted focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/50 transition-all resize-none ${className}`}
    {...props}
  />
));
TextArea.displayName = 'TextArea';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose}></div>
      <div className="bg-[#131320] border border-white/10 rounded-2xl w-full max-w-md shadow-xl relative z-10 animate-fade-in overflow-hidden">
        <div className="p-6 border-b border-white/5 flex justify-between items-center bg-white/5">
          <h3 className="font-bold text-lg text-white">{title}</h3>
          <button onClick={onClose} className="text-text-muted hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>
        <div className="p-6 max-h-[80vh] overflow-y-auto custom-scrollbar">
          {children}
        </div>
      </div>
    </div>
  );
};

interface OverlayProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
  mobileTopOffset?: number;
}

export const Overlay: React.FC<OverlayProps> = ({ isOpen, onClose, title, children, className = '', mobileTopOffset = 96 }) => {
  // Use fixed offset - customizable for mobile/tablet, 0 for desktop
  const topOffset = isMobileOrTablet ? mobileTopOffset : 0;

  if (!isOpen) return null;

  return (
    <div
      className="fixed z-[100] flex items-end lg:items-center justify-center lg:p-4"
      style={{ top: topOffset, left: 0, right: 0, bottom: 0 }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm transition-opacity animate-fade-in"
        onClick={onClose}
        style={{ touchAction: 'none' }}
      ></div>

      {/* Content */}
      <div className={`relative w-full lg:max-w-lg bg-[#131320] lg:rounded-2xl rounded-t-2xl border-t lg:border border-white/10 shadow-2xl flex flex-col lg:h-auto lg:max-h-[80vh] animate-slide-up ${className}`}
        style={{ height: '100%', marginBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/5 bg-white/5 shrink-0 rounded-t-2xl">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          <button
            onClick={onClose}
            className="p-2 text-text-muted hover:text-white rounded-lg hover:bg-white/10 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          {children}
        </div>
      </div>
    </div>
  );
};

interface TruncatedAddressProps {
  address: string;
  className?: string;
}

export const TruncatedAddress: React.FC<TruncatedAddressProps> = ({ address, className = '' }) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [displayText, setDisplayText] = useState(address);
  const [charWidth, setCharWidth] = useState(0);

  // Measure character width on mount using a hidden span
  useLayoutEffect(() => {
    if (measureRef.current) {
      // Measure with a sample of characters to get average width
      measureRef.current.textContent = 'abcdefghijklmnopqrstuvwxyz0123456789';
      const width = measureRef.current.getBoundingClientRect().width / 36;
      setCharWidth(width);
    }
  }, []);

  useEffect(() => {
    if (!wrapperRef.current || charWidth === 0) return;

    const updateDisplay = () => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;

      // Get available width from our own wrapper (which respects flex constraints)
      const containerWidth = wrapper.getBoundingClientRect().width;
      const ellipsisWidth = charWidth * 3; // "..." is 3 chars
      const safetyMargin = 4; // A few pixels buffer
      const availableWidth = containerWidth - ellipsisWidth - safetyMargin;

      // Calculate how many characters can fit
      const maxChars = Math.floor(availableWidth / charWidth);

      if (!address) {
        setDisplayText('');
        return;
      }

      // If the full address fits, show it all
      if (address.length * charWidth <= containerWidth) {
        setDisplayText(address);
        return;
      }

      // Calculate how many characters to show on each side
      // We need at least 4 chars on each side to be useful
      const minSideChars = 4;
      if (maxChars < minSideChars * 2) {
        // Not enough space, show minimal truncation
        setDisplayText(`${address.slice(0, minSideChars)}...${address.slice(-minSideChars)}`);
        return;
      }

      // Split available characters between start and end (evenly)
      const sideChars = Math.floor(maxChars / 2);
      setDisplayText(`${address.slice(0, sideChars)}...${address.slice(-sideChars)}`);
    };

    // Initial update
    updateDisplay();

    // Set up ResizeObserver to update on our wrapper resize
    const resizeObserver = new ResizeObserver(() => {
      updateDisplay();
    });

    resizeObserver.observe(wrapperRef.current);

    return () => resizeObserver.disconnect();
  }, [address, charWidth]);

  return (
    // Wrapper div that properly constrains width in flex layouts
    <div ref={wrapperRef} className="flex-1 min-w-0 overflow-hidden">
      {/* Hidden span to measure character width */}
      <span
        ref={measureRef}
        className={`font-mono text-sm absolute opacity-0 pointer-events-none whitespace-nowrap ${className}`}
        style={{ visibility: 'hidden', position: 'absolute', top: -9999 }}
        aria-hidden="true"
      />
      <span className={className}>
        {displayText}
      </span>
    </div>
  );
};