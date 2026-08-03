# GitHub Markdown Reader

[![Quality and Pages](https://github.com/gws0920/github-markdown-reader/actions/workflows/pages.yml/badge.svg)](https://github.com/gws0920/github-markdown-reader/actions/workflows/pages.yml)

在线访问：<https://gws0920.github.io/github-markdown-reader/>

一个面向公开 GitHub Markdown 内容的浏览器朗读器。输入仓库、目录或单个 Markdown 文件地址，即可生成章节目录，并通过系统语音逐句朗读和同步高亮。

## 功能

- 支持 GitHub 仓库、目录和 Markdown 文件地址
- 自动发现、自然排序并连续播放章节
- 中文和英文逐句切分，当前朗读句同步高亮
- 播放、暂停、停止、切句、切章、倍速和系统语音选择
- 本地保存章节位置及播放器偏好
- Editorial 杂志式阅读排版和移动端目录抽屉
- GitHub Actions 质量检查与 Pages 自动部署

## 本地运行

需要 Node.js 20 或更高版本。

```bash
npm install --registry=https://registry.npmjs.org/
npm run dev
```

生产验证：

```bash
npm run check
```

## 支持的地址

```text
https://github.com/<owner>/<repo>
https://github.com/<owner>/<repo>/tree/<branch>/<path>
https://github.com/<owner>/<repo>/blob/<branch>/<path>.md
```

也可以通过 `?source=<encoded-github-url>` 分享指定读物。

## 浏览器支持

推荐使用最新版 Chrome 或 Edge。朗读声音来自操作系统和浏览器提供的 Web Speech API，因此不同设备上的可选声音及自然度可能不同。

应用只读取公开 GitHub 内容，不要求登录，不保存访问令牌，也不会生成或上传音频。

## 部署

推送到 `main` 后，GitHub Actions 会依次执行格式检查、代码检查、测试和生产构建，并在全部通过后部署 GitHub Pages。

仓库创建后，在 GitHub 的 Pages 设置中将来源选择为 **GitHub Actions**。
