# 9router Fork 核心架构与定制优化记录

本项目是 [decolua/9router](https://github.com/decolua/9router) 的维护与生产强化分支（Fork）。
在跟随上游快速演进的同时，本分支面向高并发长会话 Agent 场景（特别是 Claude Code、Codex、Cline、Antigravity 等），沉淀并持续维护了一系列针对 **Token 消耗、协议稳定性、反异常封锁与长会话容错** 的核心优化。

---

## 目录

1. [核心优化全景](#1-核心优化全景)
2. [Token Saver & Tool Schema 深度压缩](#2-token-saver--tool-schema-深度压缩)
3. [Headroom 智能中间层与轻量请求分流](#3-headroom-智能中间层与轻量请求分流)
4. [Claude Code / 客户端原生拟态与通道穿透](#4-claude-code--客户端原生拟态与通道穿透)
5. [CommandCode & 协议转换零丢失](#5-commandcode--协议转换零丢失)
6. [Codex 工具规范化与参数安全](#6-codex-工具规范化与参数安全)
7. [账号高可用与 400 错误防误杀机制](#7-账号高可用与-400-错误防误杀机制)
8. [非流式与强转流式透明适配](#8-非流式与强转流式透明适配)
9. [上游版本同步与演进履历](#9-上游版本同步与演进履历)

---

## 1. 核心优化全景

| 模块 | 核心源码位置 | 核心价值 |
| :--- | :--- | :--- |
| **Token Saver** | `open-sse/utils/toolSchemaCompactor.js`<br>`open-sse/utils/codexToolSchema.js` | 压缩冗余 Tool Schema 定义，降低 15%~40% 的前置上下文开销；解除 Caveman 的语言区域限制 |
| **Headroom 门限** | `open-sse/rtk/headroom.js`<br>`open-sse/handlers/chatCore.js` | 请求体积 < 50KB 旁路直通，避免小请求压缩损耗；定向压缩历史 tool_result |
| **Claude 透传** | `open-sse/executors/default.js`<br>`src/sse/handlers/chat.js` | 动态透传客户端真实 UA 与 session-id，优化 CC decoy 与并发限制，防止特征封锁 |
| **CommandCode** | `open-sse/executors/commandcode.js`<br>`open-sse/translator/request/openai-to-commandcode.js` | 修复参数丢弃，修复 first-token peek 导致的流式丢首包缺陷 |
| **Codex 规范化** | `open-sse/executors/codex.js`<br>`open-sse/utils/codexToolSchema.js` | 规范化 root-level tool schema 关键字，修复 Codex 拒绝特定 Unicode pattern 与 reasoning item |
| **账号防锁保护** | `open-sse/config/errorConfig.js`<br>`src/sse/services/auth.js`<br>`open-sse/services/accountFallback.js` | 区分客户端 Payload 400 与账号失效，绝不锁定正常账号；限制连续 400 时的无谓轮转 |
| **响应转换器** | `open-sse/handlers/chatCore/responseShapeConverters.js` | 解耦循环依赖，保障 Responses / Claude 格式在非流式与强转流式路径下的完备还原 |

---

## 2. Token Saver & Tool Schema 深度压缩

### 背景与痛点
在 MCP、Claude Code、Agent 工具链中，每次对话常携带数十甚至上百个工具的完整 JSON Schema 定义，单是 schema 往往就占据 10k~50k Tokens，导致推理延迟高且大幅消耗 API 额度。

### 实现方案
1. **Schema 结构修剪 (`toolSchemaCompactor.js`)**：
   - 保留核心字段，修剪对模型推理无实质帮助的冗余注解；
   - 工具参数 `description` 实施首句截断与字符上限保护，在确保模型理解的前提下大幅减少冗长描述。
2. **多语言 Caveman / Ponytail 提示词解除封锁**：
   - 官方实现曾对 Caveman 风格指令进行了特定 Locale 过滤；
   - 本 Fork 移除了对中文等语言的区域排斥，使所有语言的会话都能享受高效简短指令注入带来的 Token 缩减。

---

## 3. Headroom 智能中间层与轻量请求分流

### 背景与痛点
Headroom 外部压缩代理针对大上下文非常有效，但对只有两三句对话、几 KB 大小的轻量请求，经过 Headroom 压缩会带来额外的网络延迟，且极小文本压缩效果微乎其微。

### 实现方案
1. **体积阈值保护 (`minBodyBytes`)**：
   - 新增小于 50KB（可配置）请求直接跳过 Headroom 压缩，兼顾低延迟与大上下文压缩率。
2. **定向压缩历史**：
   - 优先压缩前序轮次的 `tool_result` 和长 `reasoning`，保护最新的指令与用户输入不被压缩算法损耗语义。
3. **Phantom Savings 虚假节省检测**：
   - 比较实际发送与原始报文体积，若虚假节省（< 5%）则发出警告，避免模型服务商对未压缩 payload 计费却产生压缩延迟。
4. **超时与故障回退**：
   - 超时阈值由 3s 提升至 15s，且发生异常时自动 fail-open 直通，确保业务连续性。

---

## 4. Claude Code / 客户端原生拟态与通道穿透

### 背景与痛点
使用第三方中转网关时，若硬编码固定 User-Agent 或缺少 session 上下文关联，容易引发上游安全拦截、流式 tool_name 丢失或无法享受新模型特性。

### 实现方案
1. **动态 UA 透传 (`open-sse/executors/default.js`)**：
   - 提取上游调用方（如终端 Claude Code）的真实 `User-Agent`，动态跟随客户端升级（支持至 2.1.280+）。
2. **会话关联与并发控制**：
   - 提取透传 `session-id` header，让多轮长任务在 Antigravity 等后端被识别为同一会话；
   - 施加 inflight concurrency 限制与 decoy 优化，避免瞬时并发过高导致上游触发限流。
3. **Stream Tools Decloak**：
   - 流式通道中对遮蔽的工具名进行透明解析还原，确保客户端能精准捕获 tool_use 事件。

---

## 5. CommandCode & 协议转换零丢失

1. **OpenAI Bridge 参数保护**：
   - 彻底修复 `openai-to-commandcode` 转换过程中丢失 `tool-call arguments` 的严重缺陷；
2. **First-Token Peek 修复**：
   - 针对首个 token 做嗅探（peek）以判断协议格式或错误码时，原逻辑会导致首包被丢弃，修复后利用双向缓存保证事件流完整透传。

---

## 6. Codex 工具规范化与参数安全

1. **Root-Level Tool Schema 校验修复**：
   - Codex 后端对 tool schema 根层级字段有严格白名单要求；
   - 增加 `normalizeCodexToolParameters` 与 `stripCodexUnsupportedPatterns`，自动剥离 Codex 不支持的 Unicode-property 与非标约束，避免触发 400 参数拒绝；
   - 与上游的 `strict` 参数配置完美融合。
2. **Reasoning 项容错修复**：
   - 清理并规整被 Codex 后端拒绝的非标准 reasoning items。

---

## 7. 账号高可用与 400 错误防误杀机制

### 背景与痛点
默认情况下，若请求报错 400（例如用户提示词超长、某个工具参数格式错误），网关可能误判为该 API Key 或 OAuth 账号失效，从而将其封锁冷冻（Cool-down / Lock），并在所有可用账号间疯狂轮换，导致大量账号被无辜冻结。

### 实现方案
1. **Never Lock on Request-Scoped 400**：
   - 在 `errorConfig.js`、`auth.js` 与 `accountFallback.js` 中明确区分“凭据错误/余额不足/鉴权失效”（可切号）与“请求体错误/400 Bad Request”（客户端错误，不应切号、不应封号）。
2. **轮换频次熔断 (Cap Rotation)**：
   - 对连续出现的 400 响应设置严格的轮转上限，防止恶意请求或格式错误耗尽账号池。

---

## 8. 非流式与强转流式透明适配

1. **模块依赖解耦 (`responseShapeConverters.js`)**：
   - 将格式转换器提取为独立无副作用模块，解决 `nonStreamingHandler` 与 `sseToJsonHandler` 之间的循环依赖。
2. **全格式 Claude Message 还原**：
   - 无论是 Responses 接口还是 Chat Completions，只要客户端是 Claude 格式（如 Claude Code CLI），在强转 JSON 时均转换为合规的 Claude `message` 格式，确保客户端不崩溃。

---

## 9. 上游版本同步与演进履历

| 日期 | 上游基准版本 | 同步 Commit | 关键动作与冲突消解 |
| :--- | :--- | :--- | :--- |
| **2026-09-19** | v0.5.81 | `6bb7a35` | 基础合并，确立 Headroom 与 Token-saver 核心补丁 |
| **2026-10-04** | v0.5.95 | `1b82698` | 引入生产优化：Claude 客户端 UA 动态转发、Gemini 修复、Headroom <50KB 跳过 |
| **2026-10-16** | **v0.5.104** | `d4144da` | **主要升级**：<br>1. 合并 67 个上游提交，引入 Gemini 4 Argon、Claude 5.5 (Sonnet/Opus)、AWS Bedrock、MiniMax Code；<br>2. 采纳上游更完备的 `createToolCallIdUniquifier`（Gemini 全局 tool_call_id 去重与配对）；<br>3. 融合 Codex `strict` 参数与根层级工具规范化；<br>4. 统一 `openAICompletionToClaudeMessage` 非流式转换通道；<br>5. 完整保留本 Fork 的 Token-saver、Headroom 门限跳过与防锁号机制。 |

---

## 同步记录：upstream v0.5.109（2026-10-24）

合并 `decolua/9router` v0.5.109，冲突处理遵循"保留 fork 优化"：

- `open-sse/services/accountFallback.js`：400 仍为 `noLock`（回退下一账号、不锁账号），并附带上游的 `requestScoped: true`，使 combo 能越过该成员并返回首个被拒绝的响应；409/413/422 采用上游 `requestScoped` 语义。
- `open-sse/handlers/chatCore.js`：`handleChatCore` 入参同时保留 `headroomMinBodyBytes` 与上游 `customPromptEnabled`/`customPrompt`。
- `open-sse/rtk/headroom.js`：保留 Responses 历史压缩放宽，新增 `hasNonPlainTextToolOutput`，结构化 JSON / 非文本工具输出不送往代理。
- `tests/translator/__snapshots__/golden-url-header.test.js.snap`：按 fork 行为重生成（Claude 头部不再带 `Anthropic-Dangerous-Direct-Browser-Access`）。
