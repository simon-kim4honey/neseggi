import build from '@hono/vite-build/cloudflare-pages'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'

// 빌드할 때마다 고유한 버전 해시 생성
// → /static/app.js?v=xxx 처럼 URL이 달라져 브라우저 캐시 자동 무효화
const BUILD_VERSION = Date.now().toString(36)

export default defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
  },
  plugins: [
    build(),
    devServer({
      adapter,
      entry: 'src/index.tsx'
    })
  ]
})
