import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const gateUrl = process.env.GATE_URL ?? 'http://localhost:3000';
const usePolling = process.env.CHOKIDAR_USEPOLLING === 'true';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    port: 5173,
    watch: usePolling ? { usePolling: true, interval: 300 } : undefined,
    proxy: {
      '/api': {
        target: gateUrl,
        changeOrigin: true,
      },
      '/auth': {
        target: gateUrl,
        changeOrigin: true,
      },
    },
  },
});
