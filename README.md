# weread-dashboard

个人微信读书阅读报告 + AI 对话窗口。

- 前端:`docs/`,部署到 GitHub Pages
- 后端:`worker/`,部署到 Cloudflare Workers,代理 WeRead Gateway 和 Claude API

## 开发

```bash
cd worker
npm install
npm run dev      # 本地起 Worker 在 localhost:8787
```

## 部署

```bash
cd worker
npx wrangler login
npx wrangler secret put WEREAD_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

前端 push 到 `main` 分支后,GitHub Settings → Pages 选 `main` 分支 / `/docs` 目录即可访问。
