import type { IncomingMessage, ServerResponse } from 'node:http'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'

/**
 * Serves the Vercel function in api/chat.ts during `vite dev`, so the app runs
 * locally without the Vercel CLI. The handler is loaded through Vite's SSR
 * loader, so edits to it apply on the next request.
 */
function apiDevServer(): Plugin {
  return {
    name: 'pulse-api-dev',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/chat', (req, res) => {
        handle(server, req, res).catch((err) => {
          server.config.logger.error(`[api/chat] ${err instanceof Error ? err.stack : err}`)
          if (!res.headersSent) res.statusCode = 500
          res.end()
        })
      })
    },
  }
}

async function handle(server: ViteDevServer, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)

  const abort = new AbortController()
  res.on('close', () => abort.abort())

  const request = new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: {
      'content-type': req.headers['content-type'] ?? 'application/json',
      // Lets the rate limiter tell visitors apart, as Vercel's proxy does in production.
      'x-forwarded-for': req.socket.remoteAddress ?? 'local',
    },
    body: Buffer.concat(chunks),
    signal: abort.signal,
  })

  const mod = (await server.ssrLoadModule('/api/chat.ts')) as { POST: (r: Request) => Promise<Response> }
  const response = await mod.POST(request)

  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  } finally {
    res.end()
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Make the API key, rate-limit settings and Redis credentials from .env.local visible to the API handler in dev.
  const env = loadEnv(mode, process.cwd(), ['ANTHROPIC_', 'PULSE_', 'KV_', 'UPSTASH_'])
  // Empty values are skipped, and a real shell variable wins over the file.
  for (const [key, value] of Object.entries(env)) {
    if (value && !process.env[key]) process.env[key] = value
  }

  return {
    plugins: [react(), apiDevServer()],
  }
})
