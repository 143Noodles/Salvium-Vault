import React from 'react';
import { Icons } from './Icons';

// --- BUTTON ---
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  isLoading?: boolean;
  icon?: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'primary', 
  isLoading, 
  icon,
  className = '', 
  ...props 
}) => {
  const baseStyles = "inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-dark-950 disabled:opacity-50 disabled:cursor-not-allowed";
  
  const variants = {
    primary: "bg-gradient-to-r from-salvium-primary to-salvium-secondary hover:from-salvium-secondary hover:to-salvium-primary text-white shadow-md hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0",
    secondary: "bg-dark-850 hover:bg-dark-800 text-dark-400 border border-dark-700 hover:border-salvium-primary",
    ghost: "bg-transparent hover:bg-dark-800 text-dark-500 hover:text-dark-400",
    danger: "bg-red-900/50 text-red-400 hover:bg-red-900/80 border border-red-900"
  };

  return (
    <button 
      className={`${baseStyles} ${variants[variant]} ${className}`} 
      disabled={isLoading || props.disabled}
      {...props}
    >
      {isLoading ? <Icons.Refresh className="w-5 h-5 animate-spin" /> : icon}
      {children}
    </button>
  );
};

// --- INPUT ---
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  rightElement?: React.ReactNode;
}

export const Input: React.FC<InputProps> = ({ label, error, rightElement, className = '', ...props }) => {
  return (
    <div className="w-full space-y-2">
      {label && <label className="block text-sm font-medium text-dark-500 ml-1">{label}</label>}
      <div className="relative">
        <input 
          className={`w-full bg-dark-850 border ${error ? 'border-red-500' : 'border-dark-700 hover:border-salvium-primary focus:border-salvium-primary'} text-dark-400 px-4 py-3 rounded-lg focus:outline-none focus:ring-1 focus:ring-salvium-primary/30 focus:shadow-md transition-all placeholder-dark-600 font-sans [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${className}`}
          {...props}
        />
        {rightElement && (
          <div className="absolute inset-y-0 right-0 flex items-center pr-3">
            {rightElement}
          </div>
        )}
      </div>
      {error && <p className="text-sm text-red-500 ml-1">{error}</p>}
    </div>
  );
};

// --- CARD ---
export const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`bg-dark-850 border border-dark-700 rounded-xl p-6 shadow-md ${className}`}>
    {children}
  </div>
);

// --- LOGO ---
export const Logo: React.FC<{ size?: 'sm' | 'lg' }> = ({ size = 'lg' }) => (
  <div className={`flex items-center gap-3 ${size === 'lg' ? 'mb-8' : ''}`}>
    <img 
      src="/assets/img/salvium.png" 
      alt="Salvium" 
      className={`${size === 'lg' ? 'w-10 h-10' : 'w-8 h-8'}`}
    />
    <span className={`${size === 'lg' ? 'text-2xl' : 'text-xl'} font-semibold text-dark-400 font-mono tracking-tight`}>
      SALVIUM VAULT
    </span>
  </div>
);