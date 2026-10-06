import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      // Same-origin /api → gateway; avoids browser CORS (duplicate Allow-Origin)
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        // Agent SSE：禁止代理缓冲，否则前端只会「想很久 → 一次性全文」
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            const ct = String(proxyRes.headers['content-type'] || '')
            if (ct.includes('text/event-stream')) {
              res.setHeader('Cache-Control', 'no-cache, no-transform')
              res.setHeader('X-Accel-Buffering', 'no')
              ;(res as { flushHeaders?: () => void }).flushHeaders?.()
            }
          })
        },
      },
    },
  },
})
