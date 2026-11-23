import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: mode === 'demo' ? 5174 : 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:' + (mode === 'demo' ? 4001 : 4000) },
    },
  },
}));
