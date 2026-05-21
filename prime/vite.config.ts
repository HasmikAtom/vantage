import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:8080';
const authUrl = process.env.AUTH_URL ?? 'http://localhost:3000';
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
        target: backendUrl,
        changeOrigin: true,
      },
      '/auth': {
        target: authUrl,
        changeOrigin: true,
      },
    },
  },
});
