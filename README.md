# 练字板 Copybook

书法临摹 PWA:输入文字,用内置书法字体临摹练字。

## 功能

- 自定义临摹文本与字号
- 激光笔模式:触控笔跟随光点 / 荧光笔迹(抬笔渐隐,可反复临摹)
- 触控笔书写带输入滤波,笔迹顺滑
- 手指滚动、触控笔书写自动区分
- 三种主题(暗夜 / 宣纸 / 黛蓝)
- 所有设置本地保存
- 可安装为 PWA,离线可用
- 另有单文件 HTML 构建(`npm run build`)

## 开发

```bash
npm install
npm run dev        # 开发
npm run build:pwa  # PWA 构建(部署 GitHub Pages)
npm run build      # 单文件 HTML 构建
```

推送到 main 分支自动部署 GitHub Pages;打 `v*` 标签会把单文件 HTML 附到 Release。

## License

[MIT](LICENSE)
