# dsh-next-suggestion

> DeepSeek Harness 插件 · Inline “next reply” suggestion for the chat composer.
>
> 在对话输入框里用**灰字预言你接下来最可能说的那句话**，按 `Tab` 一键填入草稿——像 GitHub Copilot，但补全的是**你自己**的下一句话。

---

## 它长什么样

助手这一轮回复刚结束，输入框里就会浮现一行灰色文字，例如：

> ~~行，那我先用几天，有问题再找你。~~

那是模型根据最近几轮对话猜的你下一句。按 `Tab` 接受，它变成可编辑的正常草稿（`Ctrl+Z` 可撤销）；不理它、开始打字，它自动消失。

## 特性

- **理解上下文**：读当前会话最近 5 条消息，模仿你的语言和口吻（中文/英文都会跟着对话走）
- **零打扰**：只在**草稿为空**时显示；有内容就自动隐藏；不弹窗、不抢焦点
- **一键接受**：`Tab` 插入，走编辑器原生的插入接口，可撤销；也可以直接点那行灰字
- **快**：Host 侧订阅 `turn/end` 事件，回复一结束立刻开始预测（不等轮询、不等静默计时），通常 2–3 秒出现
- **省钱**：按“会话 + 日志序号”缓存，每个轮次最多生成一次，重复轮询不产生额外请求；单次输出上限 700 tokens
- **纯 JS，无需构建**：Host 半是 ESM 模块，Client 半是浏览器直接加载的单文件

## 安装

### 方式一：本地目录

```bash
# 把仓库克隆到任意位置
git clone https://github.com/msun1999/dsh-next-suggestion.git
```

然后在 DeepSeek Harness 里让它作为 bundle 安装（`plugin_manager` 的 `install_bundle`，target 指向该目录的绝对路径）。
安装后插件会以 `include:next-suggestion` 出现在 profile 里，重启 GUI 依然生效。

### 方式二：直接从 GitHub 装

```bash
# 在 profile 目录里
pnpm add github:msun1999/dsh-next-suggestion
```

见方式三的 `cordis.patch.yml` 片段。

### 方式三：手动接入 profile

1. 把包加入 profile 的依赖（`pnpm add <路径或包名>`）
2. 在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: next-suggestion
      name: 'dsh-next-suggestion'
```

3. 刷新 Web UI 页面

> 需要 **Web** 形态的 GUI（`dsh.client.platform = "web"`）与内置的 `@deepseek-ai/dsh-client-ui-conversation`（对话界面）插件。

## 使用

| 操作 | 结果 |
| --- | --- |
| 什么都不做 | 灰字在输入框里徘徊，随时可接受 |
| `Tab` | 接受建议，写入草稿（可 `Ctrl+Z` 撤销） |
| 点击灰字 | 同上 |
| 直接开始打字 | 灰字消失，正常输入 |
| 发出去 / 换会话 | 该位置的建议被消费，不再重复出现 |

## 工作原理

```
一轮回复结束
   │  Host 订阅 session/event.turn/end
   ▼
生成预测（llm.stream，最近 5 条消息 + 指令，reasoningEffort=low）
   │  结果按 (sessionId, seq) 缓存
   ▼
Client 每 800ms 轮询 GET /dsh-next-suggestion/get?sessionId=…
   │
   ▼
在 conversation.input.overlay 插槽里绘制 ghost text（盖住 placeholder）
   │  Tab
   ▼
inputActions.captureInsertion() + insertText(text, span) → POST /consume
```

### 文件结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | **Host 半**：注册 HTTP 路由、读取会话日志、调用 `llm` 服务生成预测、缓存与预热 |
| `client.js` | **Client 半**：注册到 `conversation.input.overlay` 插槽，测量输入框位置、绘制 ghost text、处理 `Tab` |
| `cordis.patch.yml` | 把插件插入 profile 的 Loader 配置 |
| `locale/*.json` | 插件在「插件」面板里的标题与描述（中/英） |

### Host 路由

| 路由 | 说明 |
| --- | --- |
| `GET /dsh-next-suggestion/get?sessionId=` | 返回 `{ text }`。`&refresh=1` 丢弃缓存重新生成；`&debug=1` 只读返回诊断字段（不触发生成） |
| `POST /dsh-next-suggestion/consume` | `{ sessionId }`，标记该位置的建议已被接受/丢弃，不再重复出现 |

数据来源与模型选择都跟随当前会话：

```js
ctx.get('sessions').get(id).deriveMessages()                       // 会话上下文
ctx.get('agentDefaultModel').currentSelection()                    // 用户当前选的模型
ctx.get('llm').stream({ provider, model, system, messages, … })    // 生成预测
```

## 可调参数

`index.js`：

| 常量 | 默认值 | 含义 |
| --- | --- | --- |
| `KEEP_MESSAGES` | `5` | 喂给模型的最近消息条数 |
| `MAX_MESSAGE_CHARS` | `300` | 单条消息截断（助手侧） |
| `MAX_USER_CHARS` | `400` | 单条消息截断（用户侧） |
| `MAX_TRANSCRIPT_CHARS` | `3200` | 整段对话总长度上限 |
| `MAX_SUGGESTION_CHARS` | `120` | 建议句最大长度 |
| `CACHE_LIMIT` | `200` | 缓存会话数上限 |
| `TIMEOUT_MS` | `25000` | 单次生成超时 |
| `STABLE_MS` | `1200` | 没有状态事件时的静默判定阈值 |
| `maxTokens` / `reasoningEffort` | `700` / `'low'` | 生成预算与思考强度 |

> `maxTokens` 别压太低：思考内容会先吃掉预算，压到 300 左右会出现“思考写完但正文为空”的空建议。

`client.js`：

| 常量 | 默认值 | 含义 |
| --- | --- | --- |
| `POLL_MS` | `800` | 轮询建议的间隔 |
| `PROBE_MS` | `300` | 测量输入框位置与空状态的间隔 |

## 已知限制

- 只在**草稿为空**时提示；已有内容不显示
- 同一轮里反复改草稿不会重算，要等下一轮回复结束才更新
- 依赖输入框实现为 `contenteditable="true"`，且 placeholder 写在属性上；若对话界面大改，需要重新校准 `pickEditor()` 与背景取色
- 预测走当前会话所用的模型；若该模型思考很长，出现时间会相应变慢
- 建议可能不准——它只是**一句话级**的猜测，接受前请自己过一眼

## 开发与调试

改完 `index.js` / `client.js` 后，把 profile 里的 `include:next-suggestion` 关掉再打开即可重载（ESM 缓存会被重置、Client bundle 版本号会更新）；不行就再刷新一次浏览器页面。

诊断接口：

```bash
curl "http://127.0.0.1:<gui-port>/dsh-next-suggestion/get?sessionId=session-xxxx&debug=1"
```

返回 `sessionFound / seq / tailRole / ready / busy / inflight / cachedSeq / lastMs / lastRaw / lastError / target / text`，可用来确认是否命中会话、是否在生成、上一次生成花了多久、原始输出有没有被清理。

## License

[MIT](./LICENSE)
