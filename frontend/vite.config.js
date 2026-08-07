import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Every API call in the app is a relative '/api/...' with no axios baseURL,
  // which is right in production (one process serves both) but meant the
  // documented two-server dev setup couldn't work: requests hit Vite on :5173
  // and 404'd before CORS was ever consulted. Proxying makes dev same-origin,
  // so cookies flow and CORS_ORIGINS isn't needed either.
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3000',
        changeOrigin: false, // keep the Host header so the session cookie matches
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
