/** @type {import('tailwindcss').Config} */
// Tailwind powers the new premium surfaces (login, PWA chrome, sync cards).
// The classic design system in styles.css keeps running untouched — the two
// share the same tokens below, so colours always match.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#2563eb', dark: '#1d4ed8', light: '#dbeafe' },
        success: { DEFAULT: '#16a34a', light: '#dcfce7' },
        danger: { DEFAULT: '#dc2626', light: '#fee2e2' },
        warning: { DEFAULT: '#d97706', light: '#fef3c7' },
        ink: '#0f172a',
        muted: '#64748b',
        line: '#e2e8f0',
        surface: { DEFAULT: '#ffffff', muted: '#f8fafc', bg: '#f1f5f9' },
        sidebar: { DEFAULT: '#0f172a', hover: '#1e293b' }
      },
      borderRadius: { card: '10px', login: '18px' },
      boxShadow: {
        card: '0 1px 3px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.04)',
        login: '0 36px 70px rgba(0,0,0,.45)'
      },
      fontFamily: {
        sans: ['Segoe UI', 'system-ui', '-apple-system', 'Roboto', 'Arial', 'sans-serif']
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '.55' }
        }
      },
      animation: {
        'fade-up': 'fade-up .35s ease both',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite'
      }
    }
  },
  plugins: []
};
