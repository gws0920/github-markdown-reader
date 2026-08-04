# Markdown & PDF Reader

[![Quality and Pages](https://github.com/gws0920/github-markdown-reader/actions/workflows/pages.yml/badge.svg)](https://github.com/gws0920/github-markdown-reader/actions/workflows/pages.yml)

在线访问：<https://gws0920.github.io/github-markdown-reader/>

一个在浏览器中运行的 Markdown 与 PDF 朗读器。输入公开 GitHub 地址、PDF 链接或选择本地 PDF，即可生成章节目录，并通过本地神经语音逐句朗读和同步高亮。

## 功能

- 支持 GitHub 仓库、目录和 Markdown 文件地址
- 支持公开 PDF 链接和本地 PDF 文件，按页面生成连续朗读目录
- PDF 内容仅在浏览器中解析，不上传文件或提取后的文字
- 自动发现、自然排序并连续播放章节
- 中文和英文逐句切分，当前朗读句同步高亮
- 首次播放时按需加载浏览器本地中文神经语音，失败时自动回退系统语音
- 播放、暂停、恢复、切句、切章、倍速和连续播放
- 4 MiB 模型分片断点续传，关闭页面后保留已完成进度
- 本地保存章节位置及播放器偏好
- Editorial 杂志式阅读排版和移动端目录抽屉
- GitHub Actions 质量检查与 Pages 自动部署

## 本地运行

需要 Node.js 20 或更高版本。

```bash
npm install --registry=https://registry.npmjs.org/
npm run dev
```

`npm run dev` 会先从公开 CDN 下载并校验本地开发所需的 Worker、JavaScript 和 WASM 文件。约 205 MB 的语音模型不会写入仓库，仍由浏览器 Service Worker 分片下载到 IndexedDB，并支持刷新后续传。

生产验证：

```bash
npm run check
```

## 语音资源加速

体积最大的本地语音模型优先从 Hugging Face 公共 CDN 下载，失败时自动回退到随 GitHub Pages 部署的仓库资源。仓库管理员可设置 GitHub Actions Secret `HF_TOKEN`，并按需设置 Variable `HF_REPO_ID`，随后手动运行 `Mirror Voice Runtime` 工作流，将 `voice-runtime-v1` Release 资源同步到公开 Dataset 仓库。默认目标为 `gws0920/github-markdown-reader-voice-runtime`。

`.data` 模型按照 4 MiB 分片下载，每个完成分片在校验 SHA-256 后写入 IndexedDB。关闭页面或点击取消只会终止当前请求，已经完成的分片会在下次播放时继续使用；Worker、JavaScript 和 WebAssembly 文件仍使用 Cache Storage 整文件缓存。模型版本或文件摘要变化时，旧模型分片会自动淘汰。

播放器会直接显示当前使用“本地续传”“CDN 下载”或“Pages 备用”，并区分缓存检查、模型下载、模型载入、运行时启动和 TTS 初始化阶段。初始化超过五分钟会自动切换到系统语音并继续朗读当前句。

“清除语音缓存”会同时删除 IndexedDB 中的模型分片和 Cache Storage 中的运行时文件。Chrome DevTools 可在 **Application → IndexedDB → github-markdown-reader-voice-chunks** 查看模型分片，在 **Application → Cache Storage** 查看 Worker、JavaScript 和 WebAssembly 缓存。Network 面板中同源 `.data` 外层响应包含 `X-Voice-Runtime-Source`、`X-Voice-Runtime-Cache`、`X-Voice-Runtime-Resume-Bytes` 和 `X-Voice-Runtime-Total-Bytes`；Service Worker 发起的 Hugging Face Range 请求是内部下载请求。

## 支持的输入

```text
https://github.com/<owner>/<repo>
https://github.com/<owner>/<repo>/tree/<branch>/<path>
https://github.com/<owner>/<repo>/blob/<branch>/<path>.md
https://example.com/document.pdf
```

也可以点击“选择 PDF”读取本地文件。公开链接需要允许浏览器跨域访问；不允许跨域的链接请先下载，再通过本地文件方式打开。

通过 `?source=<encoded-url>` 可以分享 GitHub 或公开 PDF 读物，本地文件不能通过链接分享。

## 浏览器支持

推荐使用最新版 Chrome 或 Edge。默认使用浏览器本地 Kokoro 神经语音；模型不可用时自动回退操作系统提供的 Web Speech API。

应用只读取公开 GitHub 内容和用户指定的 PDF，不要求登录，不保存访问令牌，也不会上传文章、PDF 或生成的音频。

高质量语音模型只在用户首次点击播放后下载，并由浏览器缓存。模型与运行时来源和许可证见 `THIRD_PARTY_NOTICES.md`。

## 部署

推送到 `main` 后，GitHub Actions 会依次执行格式检查、代码检查、测试和生产构建，并在全部通过后部署 GitHub Pages。

仓库创建后，在 GitHub 的 Pages 设置中将来源选择为 **GitHub Actions**。
