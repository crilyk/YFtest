# AI 互动调研与实时画像系统部署说明

## 文件入口

- `audience-h5.html`：观众扫码后的手机答题页。
- `dashboard.html`：讲师大屏页。
- `admin.html`：后台配置页。
- `index.html`：综合调试入口，可在本地同时切换三类视图。
- `server.js`：后端服务，负责页面静态托管、数据存储和 AI 接口转发。
- `data/state.json`：当前演示数据和后台配置存储文件。

## 启动方式

1. 安装 Node.js 18 或以上版本。
2. 压缩包内已包含 `.env`，可直接使用当前 AI 配置运行。
3. 如需更换 AI Key、模型或公网扫码 API 地址，修改 `.env`。
4. 在当前目录执行：

```bash
npm start
```

默认服务地址为：

- 观众端：`http://127.0.0.1:8787/audience-h5.html`
- 讲师大屏：`http://127.0.0.1:8787/dashboard.html`
- 后台配置：`http://127.0.0.1:8787/admin.html`

## 注意事项

- `.env` 内包含真实 API Key，请只在可信服务器和可信交付对象之间流转。
- 后台保存的配置、提交数据、Prompt 会写入 `data/state.json`。
- 如果设置了 `ADMIN_TOKEN`，后台地址需要追加 `?admin_token=你的值` 才能修改配置。
