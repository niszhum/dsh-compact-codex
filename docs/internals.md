# 实现说明

本文收录改动代码时需要遵守的底层约束：preset 覆盖为何必须整份搬运、模块解析怎么接、`new_context` 为何是这个形状，以及几处接口行为。

## 为什么必须覆盖整个 preset 声明

loader 的 patch 语义是按 id 寻址、整体替换目标行的 `config`，而 `applyEntryPatches` 的 `buildMap` 只递归 `group: true` 且 `config` 为数组的节点。preset 声明行（`preset-standard`）的 `config` 是对象 `{id, plugins}`、且它不是 group，**所以任何 patch 层都无法按 id 命中它内部的 `compaction-basic` 行**。

唯一可行的做法是把整份 `config.plugins` 原样搬过来、只改那一行。`sync-presets.mjs` 负责这件事：它读官方 bundle 的 preset 文件，把 `- insert:` 下的四空格缩进块反缩进成顶层 entry，并只替换压缩后端的模块名。

`command-compact` 与 `tool-result-pruner` 保持原样：

- 前者只依赖抽象 seam（其 README 明写 `Backend independent, so it follows whichever compaction service this leaf mounts`），会自动跟随新后端；
- 后者必须留在同一 isolate realm 内，因为基类要靠 `ctx.get('toolResultPruner')` 读它。

## 依赖解析

插件 import 的是 dsh 运行时提供的包（`@deepseek-ai/dsh-compaction-basic`、`dsh-llm` 等），它们不在插件目录的解析路径上。本包用**目录联接**把需要的包接到 `node_modules/@deepseek-ai/`：

```powershell
$d   = "<repo>\node_modules\@deepseek-ai"
$src = "<dsh>\resources\app\dsh\node_modules\@deepseek-ai"
foreach ($p in @("schemastery", "cordis", "dsh-compaction", "dsh-compaction-basic", "dsh-llm",
                 "dsh-util-values", "dsh-session", "dsh-app-boot", "dsh-home-paths",
                 "dsh-package-manifest")) {
  New-Item -ItemType Junction -Path "$d\$p" -Target "$src\$p" -Force
}
```

dsh 装到别的路径时，改 `$src` 即可。`node_modules/` 已在 `.gitignore` 中。

## dsh 升级后

官方更新 preset 后，生成物 `cordis.patch.yml` 会过期。重跑一次重新对齐：

```powershell
node ./sync-presets.mjs
```

生成后核对：每个 preset 声明行里压缩后端的模块名应当是 `dsh-compact-codex`；若仍是 `@deepseek-ai/dsh-compaction-basic`，说明 bundle 顺序或生成物需要修正。

Web 编辑器里保存 preset 编辑时也会按 id 覆盖 `preset-standard` 的 `config`，与插件的覆盖行是同一寻址目标。改过之后同样重跑 `sync-presets.mjs` 重新对齐。

## new_context 的实现对齐

`new_context` 的形状对齐 codex-rs 的实现，三段式来自上游（`codex-rs/core/src/tools/handlers/new_context_window.rs` 与 `codex-rs/core/src/session/turn.rs`）：

```rust
// ① 工具 handler 只发请求，回一句固定文案
invocation.session.request_new_context_window().await;
// NEW_CONTEXT_WINDOW_MESSAGE = "A new context window will start without summarizing conversation history."

// ② 每步采样后检查：needs_follow_up && take_new_context_window_request()
let should_roll_over = needs_follow_up
    && (sess.take_new_context_window_request().await || token_limit_reached);

// ③ 成立就立刻换窗，阶段是 MidTurn，然后用新窗口继续跑
run_auto_compact(..., CompactionReason::ContextLimit, CompactionPhase::MidTurn).await
// 内部以 build_world_state_for_step(..., new_window: true) 重建世界状态
```

其中 `needs_follow_up = model_needs_follow_up || has_pending_input`。

对应到 dsh 的三段：

1. 工具 `execute` 只把会话登记进进程内 `WeakSet`，回 Codex 那句原文（`empty` 的情形另给一句）。
2. **在 `agent/pre-step` 消费**——那是「上一步已收尾、工具调用与结果已配对、当前步尚未开始」的位置，等价于 Codex 的步采样后检查点。
3. 调 `compactRegion(start, end, agent)` 执行换窗：`start` 跳过 `system/message` 头（`compaction-basic` 的区间选择同样跳过它），`end` 取当前表面末尾——`pre-step` 时本步还没产生任何事件，所以末尾就是上一项，边界必然平衡。

**为什么不是 `compactNow`。** 它最终落到 `Agent.runMaintenance()`，契约是 `@throws synchronously when turn-driving or another maintenance task already owns the agent`——turn 进行中调用会同步抛。`compactRegion` 才是 turn 内路径（provider 用 `owner: 'current-turn'` 记录归属）。

**被拒的步不消费请求。** `pre-step` 是 waterfall，必须先 `next()`；下游决定 `reject` 时本步不会发生，此时换窗等于把请求浪费掉，所以留到下个步边界。换窗失败也只记一行日志，不阻断这一步。

## 已知边界

**子类不得使用类私有方法。** Cordis 的 ReflectService 会把服务实例包进 Proxy（`cordis/lib/index.js` 里的 `new Proxy(this, ReflectService.handler)`）。Proxy 转发普通属性，但不携带私有方法的 `[[PrivateBrand]]`，所以子类里的 `this.#someMethod()` 会在运行期抛 `Receiver must be an instance of class anonymous`。基类把它归类成 `summary` 失败，`/compact` 只显示那句兜底的 `Compaction could not produce a useful summary.`——真实原因必须去 `compaction/end` 事件的 `error` 字段里找。本插件的辅助逻辑一律写成模块级函数、显式传参。基类不使用私有方法，因此这条约束只作用于子类。

**`Config` 必须自行声明。** 不能沿用基类的 `Config`：Schemastery 会剥离未声明的字段，自有字段到不了构造函数，而且 Cordis 的兼容性准入也会按这份声明校验。基类新增字段时，这里要同步。

**JSON Schema 的必填项是顶层 `required` 数组。** 属性里不能带 `required: true`。写成 `defineTool` 那种 schema spec 的形态会被 `assertSupportedJsonSchema` 直接拒掉，报 `unsupported JSON schema: schema.properties.X.required is not supported on type "string"`。

**工具用对象字面量而不是 `defineTool()`。** 后者只是把 schema spec 转成 JSON Schema 再包一层参数校验，而 `ctx.tools.register` 只要求 `output.schema` 是 JSON Schema、`output.render` 是函数。本包 `package.json` 没有 dsh 内部包依赖，手写省掉一个解析不到的 import。Codex 那边 `output_schema` 为 `None`，但 dsh 的 `register` 强制要求 `output { schema, render }`，所以保留一个最小 schema 只为满足这条契约。

**`tools` 是独立服务。** 本插件按压缩引擎的形态挂载、不保证它已就绪，所以用动态 `ctx.inject(['tools'], …)` 等它可用再注册；注册失败只打一行日志，不拖垮压缩本体。

**压缩失败的文案不对应真实原因。** 失败时 `/compact` 会显示 `Compaction could not produce a useful summary.`。这条文案是 `ManualCompactionError` 的兜底类别，排障请以 `compaction/end` 事件的 `error` 字段为准。

**`reset` 模式丢弃的历史仍完整保留**于 append-only 会话日志，回放确定性不受影响。

**会话日志的两个格式特征。** 会话文件是追加式多 frame zstd（必须按魔数 `28 B5 2F FD` 切帧逐帧解压，否则只会解出第一帧的 session header）；同一会话常同时存在 `session.v3` 与 `session.v4` 两份日志（必须择一，否则计数翻倍）。
