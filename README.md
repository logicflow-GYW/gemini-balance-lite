# 🚀 Gemini Balance Lite V4 (Enhanced Edition)

**Gemini Balance Lite V4** 是一个运行在 Cloudflare Workers 上的高级 API 聚合网关。它旨在将多个 Google Gemini API Keys 聚合为一个单一的、高可用的、兼容 OpenAI 格式的端点。

通过自适应配额学习、智能 Key 轮询和状态同步机制，该项目能将不稳定的免费 API Key 转换为一个工业级的稳定服务。

---

## ✨ 核心特性

### 1. 🧠 自适应配额管理 (Adaptive Quota)
- **动态学习**：不再依赖硬编码的 RPM/RPD，程序会通过分析 `429 Too Many Requests` 响应实时学习每个 Key 的真实限制。
- **智能评分**：基于成功率、剩余配额和连续成功次数为 Key 打分，优先调度“最健康”的 Key。
- **状态机切换**：Key 在 `ACTIVE` $\rightarrow$ `COOLING` $\rightarrow$ `EXHAUSTED` $\rightarrow$ `FAILED` 之间自动切换。

### 2. 🔌 完美兼容 OpenAI 协议
- **无缝接入**：支持 `/v1/chat/completions`, `/v1/embeddings`, `/v1/models` 等标准端点。
- **多模态支持**：支持图片、音频输入及 Google Search 增强模式。
- **流式输出**：完美支持 SSE 流式传输，确保打字机效果流畅。

### 3. 💭 思考模式 (Reasoning/CoT) 控制
针对 Gemini 2.0 系列模型，提供三种思考内容显示模式（通过环境变量 `THINKING_DISPLAY_MODE` 配置）：
- `separate` (默认)：将思考过程放入 `reasoning_content` 独立字段。
- `inline`：使用 `<thinking>` 标签将思考过程合并至正文。
- `hidden`：完全隐藏思考过程。

### 4. 🛡️ 鲁棒性与防封禁
- **指纹随机化**：随机模拟官方 Python/JS/Go SDK 的 User-Agent，降低被识别为代理的风险。
- **全局熔断**：当所有 Key 耗尽时触发熔断机制，强制进入冷却期，保护 IP 权重。
- **智能节流**：根据配额使用率自动引入微小随机延迟，模拟人类请求行为。

### 5. 📊 实时监控与维护
- **统计面板**：访问 `/stats` 查看集群整体容量、Key 状态分布及成功率。
- **健康探测**：通过 `/probe` 接口一键测试并恢复失效的 Key。
- **KV 缓存**：内置极简 KV 缓存机制，减少重复请求对配额的消耗。

---

## 🛠️ 部署指南

### 1. 准备工作
- 一个 Cloudflare 账号。
- 若干个 Gemini API Key。
- 创建两个 Cloudflare KV 命名空间：
  - `KV_STATS`：用于存储 Key 的实时状态和配额计数。
  - `GEMINI_DATA`：用于存储响应缓存（可选）。

### 2. 部署步骤
1. 创建一个新的 Cloudflare Worker。
2. 将 `_worker.js` 的内容复制到编辑器中。
3. 在 Worker 的 **Settings $\rightarrow$ Variables** 中绑定以下环境变量：

| 变量名 | 必填 | 说明 | 示例 |
| :--- | :---: | :--- | :--- |
| `AUTH_TOKEN` | ✅ | 访问网关的鉴权 Token | `your_secure_password` |
| `KV_STATS` | ✅ | 绑定 KV 命名空间 | `(KV Binding)` |
| `GEMINI_DATA` | ❌ | 绑定 KV 命名空间 (用于缓存) | `(KV Binding)` |
| `MAX_RETRIES` | ❌ | 请求失败后的最大重试次数 | `2` |
| `THINKING_DISPLAY_MODE`| ❌ | `separate` / `inline` / `hidden` | `separate` |

---

## 📖 API 使用说明

### 鉴权方式
所有请求必须在 Header 中携带 `X-Auth-Token` 或在 URL 参数中携带 `token`：
```http
X-Auth-Token: your_secure_password
```

### 核心端点
- **Chat Completions**: `POST /v1/chat/completions`
- **Embeddings**: `POST /v1/embeddings`
- **Models List**: `GET /v1/models`
- **统计面板**: `GET /stats` (支持 `?action=summary` 或 `?action=keys`)
- **Key 验证**: `POST /verify` (Header 传入 `x-goog-api-key: key1,key2...`)
- **健康探测**: `POST /probe`

### 示例请求 (OpenAI 格式)
```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: your_secure_password" \
  -H "Authorization: Bearer key1,key2,key3" \
  -d '{
    "model": "gemini-2.0-flash",
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": true
  }'
```

---

## ⚖️ 免责声明
本项目仅用于技术研究与学习，请在遵守 Google API 服务条款的前提下使用。作者不对因滥用 API 导致的 Key 封禁负责。
