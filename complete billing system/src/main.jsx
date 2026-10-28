import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initTheme } from './theme.js';
import { startOutbox } from './sync-outbox.js';
import './styles.css';

initTheme();
startOutbox();

createRoot(document.getElementById('root')).render(<App />);

// PWA: installable + keeps working when the internet drops (production only —
// the vite dev server has its own rules)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* private mode / storage blocked — the app still runs, just not installable */
    });
  });
}
