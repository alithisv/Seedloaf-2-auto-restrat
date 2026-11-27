# Seedloaf Auto Start

基于 **GitHub Actions + Playwright** 的 Seedloaf 免费 Minecraft 服务器定时巡检与自动开机工具。支持通过 **sing-box** 挂载代理节点出口，并在每次巡检或开机后通过 **Telegram** 推送状态与面板截图。

## 核心功能

- **定时巡检与自动开机**：默认每天北京时间 **08:00** 和 **20:00** 自动访问控制台，检测到 `Start World`（停机状态）即自动点击启动，运行中则跳过。
- **自动邮箱密码登录**：自动处理 Clerk 登录页（兼容单步与两步登录流程），精准定位表单提交按钮，避免误触 Discord 第三方登录。
- **sing-box 节点出口支持**：可选配置单条 `vless://`、`vmess://`、`hy2://` 或 `hysteria2://` 节点链接，自动拉取最新版 sing-box 并挂载至浏览器流量，隐藏 GitHub Actions 默认机房 IP。
- **Telegram 图文通知**：直连推送巡检结果、北京时间、当前出口 IP 及全页截图，即使代理节点失效也能收到报错通知。
- **调试截图归档**：每次运行自动将截图上传至 GitHub Actions Artifacts（保留 3 天），方便排查异常。

## 项目目录结构

```text
seedloaf-auto-start/
├── .github/
│   └── workflows/
│       └── check.yml      # GitHub Actions 定时任务与 sing-box 安装流程
├── index.js               # Playwright 自动登录、状态检测与开机主脚本
├── singbox.js             # VLESS / VMess / Hysteria2 节点解析与本地代理启动
├── telegram.js            # Telegram Bot 文本与截图推送模块
├── package.json           # 项目依赖配置
└── README.md
```

## 快速部署

### 1. 创建私有仓库
在 GitHub 新建一个 **Private（私有）** 仓库，并将上述文件按目录结构上传至仓库根目录。

### 2. 配置 GitHub Secrets
进入仓库的 **Settings → Secrets and variables → Actions → Secrets** 标签页，在 **Repository secrets** 区域点击 **New repository secret**，依次添加以下变量：

| Secret 名称 | 必填 | 说明 |
| :--- | :---: | :--- |
| `SEEDLOAF_EMAIL` | 是 | Seedloaf 登录邮箱 |
| `SEEDLOAF_PASSWORD` | 是 | Seedloaf 登录密码 |
| `SEEDLOAF_WORLD_ID` | 推荐 | 控制台 URL 中 `/dashboard/` 和 `/console` 之间的 UUID（例如 `7e308acf-feb0-...`） |
| `PROXY_URI` | 选填 | 单条代理节点链接，留空则使用 GitHub Actions 默认直连 |
| `TG_BOT_TOKEN` | 选填 | Telegram 机器人 Token（通过 `@BotFather` 获取） |
| `TG_CHAT_ID` | 选填 | 接收通知的用户或群组 ID（通过 `@userinfobot` 获取） |

> **注意**：请务必填写在 **Secrets → Repository secrets** 中，切勿误填到 **Variables** 标签页或 **Environment secrets** 中，否则工作流无法读取。

### 3. 手动测试运行
1. 打开仓库顶部的 **Actions** 标签页。
2. 在左侧选中 **Seedloaf Auto Start**。
3. 点击右侧 **Run workflow** 手动触发一次，观察运行日志并确认 Telegram 是否收到带截图的通知。

## 代理协议支持（`PROXY_URI`）

- **VLESS**：支持 TCP / WS / gRPC / HTTPUpgrade / H2，支持 TLS、Reality 与 uTLS 指纹。
- **VMess**：支持标准 Base64 JSON 链接，支持 TLS、WS / gRPC / H2。
- **Hysteria2**：支持 `hy2://` 与 `hysteria2://`，支持 SNI、ALPN、Salamander 混淆与上下行带宽参数。

## 修改定时规则

打开 `.github/workflows/check.yml` 修改 `cron` 表达式（GitHub Actions 使用 **UTC 时间**，比北京时间晚 8 小时）：

```yaml
on:
  schedule:
    # 默认：每天 UTC 00:00 和 12:00（北京时间 08:00 和 20:00）
    - cron: '0 0,12 * * *'
```

## 常见问题

- **提示缺少 `SEEDLOAF_EMAIL` 或 `SEEDLOAF_PASSWORD`**
  请检查是否把密钥填进了 **Variables** 标签页或拼写有误，必须全大写并保存在 **Repository secrets** 下。
- **定时任务过了一段时间不再自动执行**
  GitHub 会在仓库连续 **60 天没有任何新 commit** 时自动暂停 `schedule` 定时任务，定期手动点击启用或提交一次小改动即可恢复。
- **触发人机验证或新设备登录拦截**
  尝试在 `PROXY_URI` 中更换更纯净的住宅/小众节点 IP，并在 Actions 运行记录底部下载 `seedloaf-screenshots` 截图查看具体拦截页面。
