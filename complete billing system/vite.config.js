import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Split vendors into purpose-sized chunks and let route pages load on
    // demand (see src/App.jsx) — no giant single bundle, faster first paint,
    // and the service worker caches every chunk for offline use.
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          const p = id.replace(/\\/g, '/');
          if (p.includes('react-dom') || p.includes('node_modules/react/') || p.includes('scheduler')) return 'vendor-react';
          if (p.includes('framer-motion') || p.includes('motion-dom') || p.includes('motion-utils')) return 'vendor-motion';
          if (p.includes('lucide-react')) return 'vendor-icons';
          if (p.includes('dexie')) return 'vendor-db';
          if (p.includes('@supabase')) return 'vendor-cloud';
          if (p.includes('jsbarcode')) return 'vendor-barcode';
          if (p.includes('@radix-ui')) return 'vendor-radix';
          return 'vendor';
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
});
