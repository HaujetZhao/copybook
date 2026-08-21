import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

// PWA 构建配置:用于 GitHub Pages 在线版(可安装、可离线)。
// 与 vite.config.js(单文件构建)分开:PWA 的 service worker 和 manifest 必须是独立外链文件。
// ponytail: 两套配置而非参数化,各自清晰。
export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: '练字板',
        short_name: '练字板',
        description: '书法字体练字板:临摹、激光笔、多主题。',
        theme_color: '#1e1f24',
        background_color: '#1e1f24',
        display: 'standalone',
        start_url: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // 字体 ttf 必须预缓存,否则离线时预览会退回系统字体
        globPatterns: ['**/*.{js,css,html,svg,png,json,wasm,woff2,ttf}'],
        // 字体 ttf 5.5MB,超过 workbox 默认 2MiB 预缓存上限,抬高到 10MiB
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
    }),
  ],
  base: './',
});
