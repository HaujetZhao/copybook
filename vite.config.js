import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 单文件构建:字体经 CSS @font-face 引入,被 singlefile 内联为 base64,产出独立 HTML。
export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  base: './',
});
