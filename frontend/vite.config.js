import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // Local dev: the app calls the API with relative URLs (/api/...), so the dev
  // server proxies them to the backend on :3000. This is what makes the
  // two-server workflow (backend + `npm run dev`) work at all — without it,
  // /api requests hit Vite itself and 404. No CORS configuration is needed,
  // since the browser only ever talks to :5173.
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
