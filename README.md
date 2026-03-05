# @lakphy/local-router

`@lakphy/local-router` 是一个本地 AI CLI 网关工具。  
安装后通过 `local-router` 命令启动服务，把 OpenAI/Anthropic 风格请求统一转发到你配置的上游 provider。

## 安装（CLI 使用者）

运行要求：Bun `>=1.2.0`

全局安装（推荐）：

```sh
npm i -g @lakphy/local-router
```

或用 Bun 全局安装：

```sh
bun add -g @lakphy/local-router
```

不全局安装，临时执行：

```sh
npx @lakphy/local-router --help
# 或
bunx @lakphy/local-router --help
```

## 快速开始

### 1) 初始化配置

```sh
local-router init
```

默认配置路径：

- 优先当前目录：`./config.json5`
- 否则全局目录：`~/.local-router/config.json5`

### 2) 编辑配置文件

最小可用配置示例：

```json5
{
  providers: {
    openai: {
      type: "openai-completions",
      base: "https://api.openai.com/v1",
      apiKey: "sk-xxxx",
      models: {
        "gpt-4o-mini": {}
      }
    }
  },
  routes: {
    "openai-completions": {
      "*": { provider: "openai", model: "gpt-4o-mini" }
    }
  }
}
```

### 3) 启动服务

```sh
local-router start
```

默认地址：

- 服务：`http://127.0.0.1:4099`
- 管理面板：`http://127.0.0.1:4099/admin`
- API 文档：`http://127.0.0.1:4099/api/docs`

## 常用命令

```sh
local-router --help
local-router init
local-router start
local-router start --daemon
local-router stop
local-router restart --daemon
local-router status
local-router status --json
local-router health
local-router logs --follow
local-router version
```

常用参数：

- `--config <path>`：指定配置文件路径
- `--host <host>`：指定监听地址
- `--port <port>`：指定监听端口
- `--daemon`：后台运行

## 请求入口（给你的应用调用）

把应用的 base URL 指向 local-router 后，使用以下入口：

- `POST /openai-completions/v1/chat/completions`
- `POST /openai-responses/v1/responses`
- `POST /anthropic-messages/v1/messages`

示例（OpenAI Chat Completions）：

```sh
curl -X POST "http://127.0.0.1:4099/openai-completions/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"请回复 ok"}]
  }'
```

## 配置规则（必须知道）

- `providers`：定义上游服务（类型、地址、密钥、模型）
- `routes`：定义路由映射（传入 model -> 目标 provider/model）
- 每个入口都必须有 `*` 兜底规则
- `routes` 里引用的 `provider` 必须在 `providers` 中存在
- `log` 是可选，不配置就不记录日志

完整 schema：`config.schema.json`

## 日志与管理面板

- 面板地址：`/admin`
- 健康检查：`GET /api/health`
- 日志列表：`GET /api/logs/events`
- 日志详情：`GET /api/logs/events/:id`
- 日志导出：`GET /api/logs/export?format=json|csv`
- 实时 tail：`GET /api/logs/tail`（SSE）

默认日志目录：`~/.local-router/logs`

- 事件日志：`events/YYYY-MM-DD.jsonl`
- 流式原文：`streams/YYYY-MM-DD/<request_id>.sse.raw`

## 常见问题

### 客户端还需要带上游 API Key 吗？

一般不需要。local-router 会使用你在配置文件 `providers.*.apiKey` 中设置的密钥转发。

### 启动失败怎么办？

先检查：

- 端口 `4099` 是否已占用（可用 `--port` 修改）
- `routes.<type>` 是否缺少 `*` 规则
- `routes` 引用的 provider 是否存在
- 配置文件是否是合法 JSON5

### 如何升级？

```sh
npm i -g @lakphy/local-router@latest
# 或
bun add -g @lakphy/local-router@latest
```

### 如何卸载？

```sh
npm rm -g @lakphy/local-router
# 或
bun remove -g @lakphy/local-router
```
