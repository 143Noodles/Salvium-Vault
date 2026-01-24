/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './index.html',
    './App.tsx',
    './index.tsx',
    './components/**/*.{ts,tsx}',
    './views/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}',
    './wallet/**/*.{js,ts}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        'bg-primary': '#0f0f1a',   // Deep dark blue/black
        'bg-secondary': '#1a1a2e', // Slightly lighter
        'bg-glass': 'rgba(21, 21, 37, 0.7)',
        'accent-primary': '#6366f1', // Indigo
        'accent-secondary': '#8b5cf6', // Violet
        'accent-success': '#10b981',
        'accent-warning': '#f59e0b',
        'text-primary': '#f8fafc',
        'text-secondary': '#94a3b8',
        'text-muted': '#64748b',
        'border-color': 'rgba(255, 255, 255, 0.08)', // Neutral, subtle border
        salvium: {
          primary: '#6366f1',
          secondary: '#8b5cf6',
          success: '#10b981',
          warning: '#f59e0b',
        },
        dark: {
          950: '#0f0f1a',
          900: '#1a1a2e',
          850: '#151525',
          800: '#1f1f35',
          700: '#1e293b',
          600: '#64748b',
          500: '#94a3b8',
          400: '#f8fafc',
        },
      },
      boxShadow: {
        'glow': '0 0 20px -5px rgba(99, 102, 241, 0.1)', // Much subtler glow
        'glow-sm': '0 0 10px -2px rgba(99, 102, 241, 0.1)',
        'inner-light': 'inset 0 1px 0 0 rgba(255, 255, 255, 0.05)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'hero-glow': 'conic-gradient(from 180deg at 50% 50%, #1a1a2e 0deg, #0f0f1a 180deg, #1a1a2e 360deg)',
      },
      keyframes: {
        'scale-in': {
          '0%': { transform: 'scale(0)', opacity: '0' },
          '50%': { transform: 'scale(1.2)' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },
      animation: {
        'scale-in': 'scale-in 0.2s ease-out forwards',
      },
    },
  },
  plugins: [],
};
