import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.PORT || 8765);

export default defineConfig({
  plugins: [react()],
  root: 'src',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${serverPort}`,
      '/raw': `http://127.0.0.1:${serverPort}`,
    },
  },
});
