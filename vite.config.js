import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { viteSingleFile } from 'vite-plugin-singlefile';

// dev server 内嵌日志接收端:页面 ?debug 面板的「发送」POST /debug-log,
// 内容直接打印到 npm run dev 的终端,真机调试无需连 Mac。
function debugLogReceiver() {
  return {
    name: 'debug-log-receiver',
    configureServer(server) {
      server.middlewares.use('/debug-log', (req, res) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          console.log('\n===== iPad 日志 =====');
          try {
            for (const line of JSON.parse(body)) console.log(line);
          } catch { console.log(body); }
          console.log('=====================\n');
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [debugLogReceiver(), vue(), viteSingleFile()],
  base: './',
});
