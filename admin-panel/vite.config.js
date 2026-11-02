import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5280, strictPort: true },
  build: {
    rollupOptions: {
      // React and the router change far less often than the app, so they get their own long-cached file.
      output: { manualChunks: { react: ['react', 'react-dom', 'react-router-dom'] } },
    },
  },
});
