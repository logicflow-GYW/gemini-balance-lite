# Gemini Balance Lite 🚀

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform: Cloudflare Workers](https://img.shields.io/badge/Platform-Cloudflare%20Workers-F38020?logo=cloudflare)](https://workers.cloudflare.com/)

Gemini Balance Lite 是一个部署在 Cloudflare Workers 上的高性能 Gemini API 负载均衡代理。它通过智能配额学习、动态 Key 轮询和多级缓存机制，旨在最大化利用 Gemini API 的免费配额，并为用户提供极低延迟、高可用的 API 访问体验。

## ✨ 核心特性

- **🤖 自适应配额管理**: 能够自动监测 `429 Too Many Requests` 响应，实时学习并动态调整每个 Key 的 RPM (每分钟请求数) 和 RPD (每日请求数) 限制，无需手动硬编码。
- **⚖️ 智能评分轮询**: 基于成功率、剩余配额和健康状态为每个 Key 打分，优先调度状态最优的 Key，并具备自动冷却和故障恢复机制。
- **🔌 OpenAI 协议兼容**: 完美支持 `/v1/chat/completions` 等 OpenAI 标准接口，可无缝接入 NextChat, LobeChat 等绝大多数主流 LLM 客户端。
- **🧠 思维链 (CoT) 控制**: 支持三种思考内容显示模式（隐藏、独立字段、行内 XML 标签），适配不同客户端的需求。
- **⚡ 智能 KV 缓存**: 可选开启基于 Cloudflare KV 的响应缓存，显著降低重复请求对 API 配额的消耗。
- **📊 增强统计面板**: 提供详细的 `/stats` 接口，实时监控所有 Key 的状态、使用率及预测耗尽时间。
- **🛡️ 安全访问控制**: 支持 `X-Auth-Token` 验证，防止接口被盗刷。

## 🚀 快速部署

### 1. 准备工作
- 一个 [Cloudflare](https://dash.cloudflare.com/) 账号。
- 一个或多个 [Google AI Studio](https://aistudio.google.com/) 的 API Key。

### 2. 部署步骤
#### 方法 A：使用 Wrangler 命令行（推荐）
```bash
# 克隆项目
git clone https://github.com/your-username/gemini-balance-lite.git
cd gemini-balance-lite

# 安装依赖
npm install

# 登录 Cloudflare
npx wrangler login

# 部署
npm run deploy
```

#### 方法 B：直接粘贴代码
1. 在 Cloudflare Workers 控制台创建一个新 Worker。
2. 将 `_worker.js` 的全部内容复制并粘贴到编辑器中。
3. 在 Worker 的 `Settings` -> `Variables` 中配置环境变量（见下文）。

### 3. 环境配置

在 Cloudflare Worker 的环境变量中设置以下项：

| 变量名 | 默认值 | 说明 | 必填 |
| :--- | :--- | :--- | :--- |
| `AUTH_TOKEN` | `your_secret_token` | 访问代理所需的 Token，请求头加入 `X-Auth-Token: ...` | 建议 |
| `MAX_RETRIES` | `2` | 当 Key 触发限流时，自动重试的最大次数 | 否 |
| `THINKING_DISPLAY_MODE` | `separate` | 思考模式：`hidden` (隐藏), `separate` (独立字段), `inline` (行内) | 否 |
| `GEMINI_DATA` | (KV Namespace) | 用于存储 API 响应缓存的 KV 绑定 | 可选 |
| `KV_STATS` | (KV Namespace) | 用于持久化存储 Key 状态和统计数据的 KV 绑定 | 可选 |

## 🛠️ 接口指南

### 1. API 请求 (OpenAI 兼容)
- **Endpoint**: `https://your-worker.workers.dev/v1/chat/completions`
- **Header**: 
  - `Authorization: Bearer key1,key2,key3` (支持多个 Key 逗号分隔)
  - `X-Auth-Token: your_secret_token` (如果配置了 AUTH_TOKEN)

### 2. 管理接口
- **验证 Key**: `POST /verify` (请求头带上 `x-goog-api-key`) $\rightarrow$ 检查 Key 是否可用。
- **统计面板**: `GET /stats` $\rightarrow$ 查看整体集群状态。
- **深度统计**: `GET /stats?action=keys` $\rightarrow$ 查看每个 Key 的详细配额。
- **强制探测**: `POST /probe` $\rightarrow$ 尝试激活所有处于 `FAILED` 状态的 Key。

## 📜 许可证
本项目采用 [MIT License](LICENSE) 开源。
