import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // In Docker Compose the api runs in a separate container, reachable
      // only by its service name — 'localhost' would mean this container.
      '/api': process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000',
    },
  },
});
