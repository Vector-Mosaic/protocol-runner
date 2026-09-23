import path from 'node:path'

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig(({ mode }) => {
  const appReactRoot = path.resolve(__dirname, 'node_modules')
  const reactRoot = appReactRoot
  const port = Number(process.env.PROTOCOL_RUNNER_UI_PORT ?? '15174')
  const host = `127.0.0.1:${port}`
  const origin = `http://${host}`
  const token = process.env.PROTOCOL_RUNNER_CONTROL_TOKEN?.trim()
  const localBoundary: Plugin = {
    name: 'runner-local-access',
    configureServer(server) {
      if (!token || token.length < 32) throw new Error('Start the dashboard through pnpm start (local control token required)')
      server.middlewares.use((request, response, next) => {
        if (request.headers.host !== host ||
            (request.headers.origin !== undefined && request.headers.origin !== origin) ||
            request.headers['sec-fetch-site'] === 'cross-site') {
          response.writeHead(403, { 'content-type': 'text/plain' })
          response.end('This dashboard accepts local same-origin requests only.')
          return
        }
        next()
      })
    },
  }
  const reactAlias = {
    react: path.join(reactRoot, 'react'),
    'react/jsx-runtime': path.join(reactRoot, 'react/jsx-runtime.js'),
    'react-dom': path.join(reactRoot, 'react-dom'),
    'react-dom/client': path.join(reactRoot, 'react-dom/client.js'),
  }
  const testAlias =
    mode === 'test'
      ? {
          'lucide-react': path.resolve(__dirname, 'src/test-lucide.tsx'),
        }
      : {}

  return {
    plugins: [react(), localBoundary],
    resolve: {
      alias: {
        ...reactAlias,
        ...testAlias,
      },
      dedupe: ['react', 'react-dom'],
    },
    server: {
      host: '127.0.0.1', port, strictPort: true, cors: false,
      proxy: {
        '/runner-api': {
          target: process.env.PROTOCOL_RUNNER_API_URL ?? 'http://127.0.0.1:14831',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/runner-api/, ''),
          configure(proxy) {
            proxy.on('proxyReq', (request) => {
              request.removeHeader('origin')
              request.setHeader('authorization', `Bearer ${token}`)
            })
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test-setup.ts',
      include: ['src/**/*.test.{ts,tsx}', 'src/**/*.spec.{ts,tsx}'],
    },
  }
})
