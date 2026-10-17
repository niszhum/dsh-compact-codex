/**
 * 压缩后端：接管 `ctx.compaction`，并注册上下文管理相关的工具与读数。
 *
 * 导出 `CodexCompactionEngine`（继承 `@deepseek-ai/dsh-compaction-basic`，只覆盖子类
 * 钩子 `summarize()`），注册 `new_context` / `ledger_append` / `ledger_read` /
 * `history` 四个工具，并在 `agent/pre-step` 注入 token 预算读数。
 *
 * 本模块内所有辅助逻辑写成模块级函数，不使用类私有方法；ctx 与 config 显式传参。
 *
 * @module dsh-compact-codex
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { appendAutoSnapshot, hasFreshEntry, renderEntries, renderHome, stampEntry, tailOf, tasksOf, validateAppend } from './ledger.js'
import { decideKeepalive, describeCache, initialCacheState, noteRequest } from './cache.js'

/** 注入消息的来源标识；会话日志里靠它区分本插件的读数与真实用户消息。 */
const SOURCE_KIND = 'compact-codex'

/** 每个会话的缓存状态，由 `registerCacheKeeper` 维护。 */
const cacheStates = new WeakMap()
/** 缓存的阈值设置，构造时填一次。 */
let cacheOptions = { ttlMs: 3_600_000, keepaliveAfterMs: 3_120_000, minCacheReadTokens: 40_000, idleKeepaliveBudget: 3, maxConsecutiveFailures: 2, enabled: true }

/** 默认的预算读数节流间隔，与 Codex 的实验上下文管理保持同一量级。 */
const DEFAULT_BUDGET_REFRESH_MS = 600_000
/** 与基类一致的默认压力余量，仅用于读数里的阈值推算。 */
const DEFAULT_HEADROOM_TOKENS = 65_536
/** 与基类一致的默认触发比例。 */
const DEFAULT_THRESHOLD_RATIO = 0.8
/** 账本单条 text 的长度上限：一句话的要点，不是流水账。 */
const DEFAULT_LEDGER_TEXT_CHARS = 1500
/** 换窗门槛：最近一次记账之后允许有多少个没记账的工具结果。 */
const DEFAULT_LEDGER_TAIL_STEPS = 25
/** 缓存 TTL 的假设值，默认 1 小时。provider 侧的真实值不下发，所以可配。 */
const DEFAULT_CACHE_TTL_MS = 3_600_000
/** 空闲多久开始保活（1 小时档即 3120 秒）。 */
const DEFAULT_KEEPALIVE_AFTER_MS = 3_120_000
/** 前缀规模下限：低于此值时不做保活。 */
const DEFAULT_MIN_CACHE_READ_TOKENS = 40_000
/** 两次真实请求之间最多保活几次。 */
const DEFAULT_IDLE_KEEPALIVE_BUDGET = 3
/** 连续失败达到这个次数后停止保活。 */
const DEFAULT_MAX_KEEPALIVE_FAILURES = 2
/** 冷缓存换窗的上下文下限。 */
const DEFAULT_COLD_MIN_TOKENS = 100_000
/** 保活检查的周期：到点看一眼，不依赖任何事件。 */
const DEFAULT_KEEPALIVE_CHECK_MS = 15_000

/** 解析最近一次已持久化请求的路由目标。 */
function routedTarget(session) {
	const config = session.requestHeader()?.config
	if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
	return { provider: config.provider, model: config.model }
}

/** 解析摘要调用该走哪条路由：显式配置 > 最近一次路由 > AgentOptions 对。 */
function resolveSummaryTarget(config, agent) {
	if (config.summarizationProvider.length > 0 && config.summarizationModel.length > 0) {
		return { provider: config.summarizationProvider, model: config.summarizationModel }
	}
	const routed = routedTarget(agent.session)
	if (routed !== undefined) return routed
	const { provider, model } = agent.options
	if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) return undefined
	return { provider, model }
}

/** 交接信息的开场白。 */
/** 开场白里讲账本的那一句：有账本时指向主页，没有时必须把这份拼装件的成色说清楚。 */
const OPENING_LEDGER_LINE =
	'> 换窗会丢掉没记进账本的东西：接手前先用 `ledger_read` 看清「进行中 / 受阻的任务」和它们的下一步。'

/** 账本为空时顶替上一句：新窗口读不到任何任务状态，只能回查原文。 */
const OPENING_NO_LEDGER_LINE =
	'> **本窗口没有留下账本记录**：下面这些由会话记录拼装而成，没有经过提炼，也说不清「做到哪一步、还差什么」。动手前先按 `#编号` 用 `history` `read` 确认原文，不要凭这份拼装件直接改代码。'

/** 交接信息的开场白。账本那一句夹在「历史回查」与「不要重做」之间。 */
function handoffOpening(hasLedger) {
	return [
		'# 上下文交接',
		'',
		'> 这是**由代码从会话记录里拼出的**交接信息，不是模型写的摘要。上一个窗口的对话正文已不在上下文里。',
		'> 条目上的 `#编号` 是会话事件编号，用 history 工具回查原文——会话记录保留完整历史，包括被压缩遮蔽的部分。',
		'> **之前跑过的命令、读过的文件，输出都在历史里**：先 `history` 的 `search` 按命令或文件名找，再按 `#编号` `read` 读原文（命令的完整原文加 `field: "input"`），不要重跑同样的探测命令。',
		hasLedger ? OPENING_LEDGER_LINE : OPENING_NO_LEDGER_LINE,
		'> 不要重做「最近的动作」里已经成功完成的事；需要重跑某条命令前，先确认它没有被列在这里。'
	].join('\n')
}

/** 交接信息的收尾指令，区分"回合中途被换走"与"正常换窗"两种情形。 */
const HANDOFF_FOOTER = [
	'---',
	'',
	'继续之前先确认一件事：上面「最近的用户请求」是用户的原话，如果你的记忆与它冲突，以它为准。',
	'然后接着用户最后的请求继续，不要重新开始一个已完成的任务。'
].join('\n')

/** 交接信息的默认规模上限，单位是估算 token。 */
const DEFAULT_HANDOFF_TOKENS = 15_000
/** 默认列出多少条最近动作与最近请求。 */
const DEFAULT_HANDOFF_ACTIONS = 12
const DEFAULT_HANDOFF_REQUESTS = 3
/** 默认列出多少个文件，以及每个动作的输入摘要长度。 */
const DEFAULT_HANDOFF_FILES = 12
const ACTION_INPUT_CHARS = 120
const ACTION_HEAD_CHARS = 160
const REQUEST_CHARS = 800
const REPLY_CHARS = 1_200

/** 粗估一段文本的 token 数：ASCII 字符按四分之一计，其余（CJK 等）按一个计。 */
function estimateTokens(text) {
	let ascii = 0
	let other = 0
	for (const char of text) {
		if (char.charCodeAt(0) < 128) ascii += 1
		else other += 1
	}
	return Math.ceil(ascii / 4) + other
}

/** 抽取一个消息块的纯文本，用于渲染请求与工具输出。 */
function textOfContent(content) {
	if (!Array.isArray(content)) return ''
	return content
		.filter((block) => block !== null && typeof block === 'object' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n')
}

/** 把一行压平并截断到 limit 个字符。 */
function clip(text, limit) {
	const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 从工具调用参数里取出最有信息量的一小段：命令、路径或首个短参数。 */
function summarizeArguments(rawArguments) {
	if (typeof rawArguments !== 'string' || rawArguments.trim() === '') return ''
	let parsed
	try {
		parsed = JSON.parse(rawArguments)
	} catch {
		return clip(rawArguments, ACTION_INPUT_CHARS)
	}
	if (parsed === null || typeof parsed !== 'object') return clip(String(parsed), ACTION_INPUT_CHARS)
	for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
		const value = parsed[key]
		if (typeof value === 'string' && value.trim() !== '') return clip(value, ACTION_INPUT_CHARS)
	}
	const first = Object.entries(parsed).find(([, value]) => typeof value === 'string' && value.trim() !== '')
	return first === undefined ? '' : clip(`${first[0]}=${first[1]}`, ACTION_INPUT_CHARS)
}

/**
 * 从会话当前的 surface 拼出交接信息。
 *
 * 三段内容：最近的用户请求、文件工作集、最近的动作。超预算时先从最近动作开始砍，
 * 再砍文件工作集；用户请求与上一次助手回复不截断。
 *
 * @param session - 提供 surface 与事件读取的会话。
 * @param options - 规模上限与条数上限。
 * @returns 交接信息正文。
 */
function assembleHandoff(session, options) {
	const nodes = session.surface.nodes
	const requests = []
	const actions = []
	const files = new Map()
	/** 最后一条含正文的助手回复。 */
	let lastReply
	for (const seq of nodes) {
		const event = session.eventAt(seq)
		if (event === undefined) continue
		const data = event.data ?? {}
		if (event.type === 'user/message') {
			// 只取真人消息。user/message 这条通道上还走着 agent-instructions、skill-catalog、
			// runtime-context（模型切换通知就走它），以及本插件自己的预算读数——把它们当成
			// 「用户的原话」带进新窗口，新窗口就会把系统文本当成权威指令。真人消息的 source
			// 形如 { kind: 'user', rpcId, clientTimeZone }，其余来源一律不是人打的。
			if (data.source?.kind !== 'user') continue
			const text = textOfContent(data.content)
			if (text.trim() === '') continue
			requests.push({ seq, text: clip(text, REQUEST_CHARS) })
			continue
		}
		if (event.type === 'assistant/message') {
			for (const block of data.message?.content ?? []) {
				if (block?.type === 'tool-call') {
					actions.push({ seq, callId: block.id, name: block.name, input: summarizeArguments(block.arguments) })
					continue
				}
				// 正文块要单独留下：ctx-mod 把「上一次助手的最后回复」列为永不截断项，
				// 理由是只给请求和动作说明不了「做到哪了、结论是什么」。
				if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
					lastReply = { seq, text: block.text }
				}
			}
			continue
		}
		if (event.type === 'tool/result') {
			const message = data.message ?? {}
			const callId = message.toolCallId
			if (typeof callId === 'string') {
				for (let index = actions.length - 1; index >= 0; index -= 1) {
					if (actions[index].callId !== callId) continue
					actions[index].resultSeq = seq
					actions[index].isError = message.isError === true
					actions[index].head = clip(textOfContent(message.content), ACTION_HEAD_CHARS)
					break
				}
			}
			// 引擎已经算好了这次调用改动了哪些文件，不必再从参数里解析路径。
			for (const diff of data.meta?.diffs ?? []) {
				if (typeof diff?.path === 'string' && diff.path !== '') files.set(diff.path, seq)
			}
		}
	}
	const recentRequests = requests.slice(-options.requests)
	const recentActions = actions.slice(-options.actions)
	const recentFiles = [...files].slice(-options.files)
	// 截断必须显式说出来：新窗口看到 12 条动作会默认它就是全部，更早的已做步骤
	// 就会被当成"还没做"重推一遍。这是「换窗后重复执行」的直接推手之一。
	const droppedActions = actions.length - recentActions.length
	const droppedRequests = requests.length - recentRequests.length
	const actionSection = recentActions.length === 0
		? ''
		: [
			'## 最近的动作（旧→新）',
			...(droppedActions > 0
				? [`（列表已截断：只保留最近 ${recentActions.length} 条，更早还有 ${droppedActions} 个动作未列出；需要判断某步是否已做过，先用 history search 查，不要凭这里的缺失下结论）`]
				: []),
			...recentActions.map((action) => {
				const input = action.input === '' ? '' : ` ${action.input}`
				const failed = action.isError === true ? '（失败）' : ''
				const head = action.head === undefined ? '' : `：${action.head}`
				return `- \`#${action.seq}\` **${action.name}**${input}${failed}${head}`
			})
		].join('\n')
	const requestSection = recentRequests.length === 0
		? ''
		: [
			'## 最近的用户请求（原话）',
			...(droppedRequests > 0 ? [`（更早还有 ${droppedRequests} 条请求未列出，可用 history search 按词回查）`] : []),
			...recentRequests.map((request) => `- \`#${request.seq}\` ${request.text}`)
		].join('\n')
	const fileSection = recentFiles.length === 0
		? ''
		: ['## 文件工作集（最近被改动的）', ...recentFiles.map(([path, seq]) => `- \`${path}\`（\`#${seq}\`）`)].join('\n')
	const replySection = lastReply === undefined
		? ''
		: [`## 上一次助手的最后回复（\`#${lastReply.seq}\`）`, clip(lastReply.text, REPLY_CHARS)].join('\n')
	const joined = (...parts) => parts.filter((part) => part !== '').join('\n\n')
	// 有账本时用账本主页替代请求段：主页里已经含「最近的用户请求（原话）」，
	// 再列一遍只是重复占预算。账本为空（还没有人记过账）时退回原来的请求段。
	const hasLedger = options.ledger !== undefined && options.ledger !== ''
	const headSection = hasLedger ? options.ledger : requestSection
	// 开场白也要跟着账本走：没有账本时那句「先读账本」会指向一片空白，
	// 得换成把拼装件成色讲清楚的警告。
	const opening = handoffOpening(hasLedger)
	const full = joined(opening, headSection, replySection, fileSection, actionSection, HANDOFF_FOOTER)
	if (estimateTokens(full) <= options.maxTokens) return full
	// 超预算时先砍最近动作，再砍文件工作集；开场白、账本主页（或请求段）与最后回复是权威，永不砍。
	const withoutActions = joined(opening, headSection, replySection, fileSection, HANDOFF_FOOTER)
	if (estimateTokens(withoutActions) <= options.maxTokens) return withoutActions
	const minimal = joined(opening, headSection, replySection, HANDOFF_FOOTER)
	// 连保底集合都超预算时不再砍，而是把话说清楚：请求与结论必须活到新窗口。
	return estimateTokens(minimal) <= options.maxTokens
		? minimal
		: `${minimal}\n\n（交接信息超出上限 ${options.maxTokens} 估算 token，最近动作与文件工作集已省略；需要时按 #编号回查原文。）`
}

/**
 * 换窗前落一条自动快照，把未记账的进度钉进账本（`through` 盖到当前 seq）。
 *
 * `new_context` 有两道账本门槛，但压力换窗与冷缓存换窗没有——压力换窗触发时
 * 模型正在干活、没机会记账。不落快照，新窗口拿到的账本停在很久以前，过时的
 * 「进行中 + 下一步」会把已完成的步骤再推一遍。快照失败不阻断换窗。
 */
function writeAutoSnapshot(session) {
	const entries = readLedger(session)
	const { steps, briefs } = unloggedStepsOf(session, entries)
	if (steps === 0) return
	const digest = sessionDigestOf(session)
	const { entries: next } = appendAutoSnapshot(entries, briefs, {
		seq: entries.reduce((top, item) => Math.max(top, Number(item.seq) || 0), 0) + 1,
		ts: Date.now(),
		window: digest.compactions + 1,
		through: session.seq,
		requestRef: digest.requests[digest.requests.length - 1]?.seq
	})
	writeLedger(session, next)
}

/**
 * 换窗：不发起模型调用，直接用交接信息替换整段历史。
 *
 * @param config - 基类解析后的配置。
 * @param agent - 目标 agent。
 * @param options - 交接信息的规模与条数上限。
 * @returns 交接信息正文。
 */
function resetSummary(config, agent, options) {
	const target = resolveSummaryTarget(config, agent)
	if (target === undefined) throw new Error('no provider/model available for context reset: set both summarization fields, route one request, or set both AgentOptions fields')
	// 换窗前先落自动快照：压力换窗没有账本门槛，这条快照让新窗口的账本时间线
	// 与交接信息对齐（覆盖边界 `#编号` 双方都看得见）。
	try {
		writeAutoSnapshot(agent.session)
	} catch (error) {
		console.error(`dsh-compact-codex: 换窗前自动快照失败: ${String(error)}`)
	}
	// 账本主页交给新窗口：它说清"要接着做什么"，而这一条恰恰是会话记录里没有的。
	// 账本为空时是空串，`assembleHandoff` 会退回原来的请求段。
	const ledger = ledgerHomeOf(agent.session, options)
	const summary = [deepFreeze({ type: 'text', text: assembleHandoff(agent.session, { ...options, ledger }) })]
	return {
		summary,
		provider: target.provider,
		model: target.model,
		maxTokens: config.maxTokens
	}
}

/**
 * 复算本路由的触发阈值，单位与基类一致。基类改动公式时这里要同步。
 *
 * @param config - 基类解析后的配置（含全局默认与按路由覆盖）。
 * @param target - 当前路由。
 * @param contextWindow - 适配器声明的窗口容量。
 * @param reservedCompletionTokens - 该请求预留的输出 token。
 * @returns 触发阈值与保留预算；容量不足时返回 undefined。
 */
function resolveBudgetSpec(config, target, contextWindow, reservedCompletionTokens) {
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
	const override = (config.modelPolicies ?? []).find((policy) => policy.provider === target.provider && policy.model === target.model)
	const thresholdRatio = override?.thresholdRatio ?? config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
	const headroomTokens = override?.headroomTokens ?? config.headroomTokens ?? DEFAULT_HEADROOM_TOKENS
	const messageBudget = contextWindow - reservedCompletionTokens
	const pressureBudget = messageBudget - headroomTokens
	if (pressureBudget <= 0) return undefined
	return {
		thresholdTokens: Math.floor(Math.min(contextWindow * thresholdRatio, pressureBudget)),
		contextWindow
	}
}

/** 渲染一条预算读数：用量、压缩触发点与剩余量。 */
function renderBudgetText(used, spec) {
	const remaining = Math.max(0, spec.thresholdTokens - used)
	const percent = ((used / spec.contextWindow) * 100).toFixed(1)
	return [
		`Context budget as of this step: about ${used} of ${spec.contextWindow} tokens used (${percent}%).`,
		`Automatic compaction triggers near ${spec.thresholdTokens} tokens; roughly ${remaining} tokens remain before that point.`
	].join('\n')
}

/**
 * 注册预算读数注入。
 *
 * 监听 `agent/pre-step`，在下游决定进入步骤且未被取消时，往 `decision.messages`
 * 末尾追加一条带来源的 user 消息。
 *
 * @param ctx - 插件 context。
 * @param config - 基类解析后的配置。
 * @param options - 上下文管理开关与阈值。
 */
function registerBudgetContext(ctx, config, options) {
	const { budgetContext, refreshMs } = options
	if (!budgetContext) return
	const stateBySession = new WeakMap()
	ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
		const decision = await next()
		if (decision.kind === 'reject' || signal.aborted) return decision
		const target = routedTarget(agent.session)
		if (target === undefined) return decision
		const info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal)
		if (info.context === undefined) return decision
		const reserved = agent.session.requestHeader()?.config.maxTokens ?? info.defaultMaxTokens ?? 0
		const spec = resolveBudgetSpec(config, target, info.context.contextWindow, reserved)
		if (spec === undefined) return decision
		const used = ctx.tokenMeter.measure(agent.session).totalTokens
		const now = Date.now()
		const state = stateBySession.get(agent.session) ?? { lastInjectionTime: null }
		stateBySession.set(agent.session, state)
		// 读数按间隔节流：每个步边界都塞一段同样的读数只会稀释真正要做的事。
		if (!(refreshMs <= 0 || state.lastInjectionTime === null || now - state.lastInjectionTime >= refreshMs)) return decision
		let text = renderBudgetText(used, spec)
		// 缓存冷热直接决定换窗的时机：缓存已冷时换窗不再额外付缓存代价（那次请求反正要整段重写），
		// 缓存还活着时换窗要先付一次重写。把这件事写进读数，模型才有依据挑时机。
		const cacheState = cacheStates.get(agent.session)
		if (cacheState !== undefined) text += `\n${describeCache(cacheState, cacheOptions, now)}`
		state.lastInjectionTime = now
		return {
			...decision,
			messages: [...decision.messages, createUserMessage({
				content: [{ type: 'text', text }],
				source: {
					kind: SOURCE_KIND,
					form: 'snapshot',
					sections: [{ name: SOURCE_KIND, text }]
				}
			})]
		}
	}, { prepend: true })
}

/** 已请求换窗、但还没执行的会话。 */
const pendingNewContext = new WeakSet()

/**
 * 注册模型可调用的换窗工具 `new_context`。
 *
 * 工具的 `execute` 只把会话登记进 `pendingNewContext`，回一句固定文案；真正的换窗在
 * `agent/pre-step` 消费该登记，交由 `compactRegion` 执行（turn 内路径，provider 用
 * `owner: 'current-turn'` 记录归属）。
 *
 * @param ctx - 插件 context（用它拿到 `tools` 服务与事件总线）。
 * @param engine - 本插件接管 `ctx.compaction` 的那个实例。
 */
function registerNewContextTool(ctx, engine) {
	const tool = {
		name: 'new_context',
		// 与 Codex 逐字一致：后半句是给模型的保证（换窗不动环境状态），它决定模型敢不敢用。
		description: 'Start a new context window. Does not clear, reset, or otherwise affect environment state.',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		output: {
			// 这是 JSON Schema，不是 `defineTool` 吃的 schema spec：必填项写成顶层
			// `required` 数组，属性里不能带 `required: true`（register 的
			// assertSupportedJsonSchema 会直接拒掉）。
			//
			// Codex 那边 output_schema 为 None；dsh 的 register 强制要求 output
			// { schema, render }，所以保留一个最小 schema，只为满足这条契约。
			schema: {
				type: 'object',
				additionalProperties: false,
				required: ['detail'],
				properties: { detail: { type: 'string' } }
			},
			render: (_args, value) => [{ type: 'text', text: value.detail }]
		},
		async execute(_args, exec) {
			const agent = exec.agent
			if (agent === undefined) throw new Error('new_context requires an owning agent session')
			const session = agent.session
			// 没有早于本步的表面节点时，换窗等于什么都没换。
			const nodes = session.surface.nodes
			if (nodes.length < 2) {
				return { detail: 'There is no earlier history to replace yet.' }
			}
			// 账本门槛：换窗会丢掉没记下来的东西，所以先确认最近的进度已经记进账本。
			// 拒绝用抛错而不是返回文案——模型对错误会重试（去记账），对平铺的结果只会念一遍。
			const refusal = ledgerGate(session)
			if (refusal !== undefined) throw new Error(`暂不换窗：${refusal}`)
			pendingNewContext.add(session)
			// 文案与 Codex 的 NEW_CONTEXT_WINDOW_MESSAGE 对齐。
			return { detail: 'A new context window will start without summarizing conversation history.' }
		}
	}
	// `tools` 是独立服务：本插件由 preset 层按压缩引擎的形态挂载，不保证它已就绪，
	// 所以用动态 inject 等它可用再注册（Cordis 会按依赖就绪调用回调）。
	ctx.inject(['tools'], (toolsCtx) => {
		try {
			toolsCtx.tools.register(tool)
		} catch (error) {
			// 注册失败不能拖垮压缩本体：这条路径是附加能力，不是插件的存在理由。
			console.error(`dsh-compact-codex: new_context tool not registered: ${String(error)}`)
		}
	})
	// 步边界消费请求：prepend 保证本插件先看到决策，但仍调 next() 让下游照常决定是否进入
	// 本步；换窗只在决定进入时做，被拒绝的步不该触发压缩。
	ctx.on('agent/pre-step', async ({ agent }, next) => {
		const decision = await next()
		const session = agent?.session
		if (session === undefined || !pendingNewContext.has(session)) return decision
		if (decision.kind === 'reject') return decision
		pendingNewContext.delete(session)
		try {
			const nodes = session.surface.nodes
			// 系统头留在表面上（compaction-basic 的区间选择同样跳过它）；end 取当前表面末尾
			// —— pre-step 时本步还没产生任何事件，所以末尾就是上一项，工具对必然已闭合。
			const headEvent = session.eventAt(nodes[0])
			const startIdx = headEvent !== undefined && headEvent.type === 'system/message' ? 1 : 0
			const endIdx = nodes.length - 1
			if (endIdx > startIdx) {
				await engine.compactRegion(nodes[startIdx], nodes[endIdx], agent)
			}
		} catch (error) {
			// 换窗失败不能把步拒掉：把原因留在日志里，让这一轮照常继续。
			console.error(`dsh-compact-codex: new_context 换窗失败: ${String(error)}`)
		}
		return decision
	}, { prepend: true })
}

/**
 * 账本的存放与读写。
 *
 * 账本落在 `$DSH_HOME/dsh-compact-codex/sessions/<会话 id>/ledger.jsonl`，不进会话事件流。
 */

/** 把会话 id 转成安全的目录名。 */
function safeSessionId(id) {
	const cleaned = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
	return cleaned === '' ? 'unknown' : cleaned
}

function ledgerDir(session) {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
	return join(home, 'dsh-compact-codex', 'sessions', safeSessionId(session?.id))
}

function readJsonFile(path) {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		// 不存在、读不动、太大：调用方一律当作"没有"。
		return undefined
	}
}

/** 账本条目；文件缺失或损坏都是空账本，不是错误。 */
function readLedger(session) {
	const text = readJsonFile(join(ledgerDir(session), 'ledger.jsonl'))
	if (text === undefined) return []
	const entries = []
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		try {
			const parsed = JSON.parse(line)
			if (typeof parsed === 'object' && parsed !== null) entries.push(parsed)
		} catch {
			// 坏行跳过，其余照读。
		}
	}
	return entries
}

/** 整文件覆盖写：账本一次几十条，追加即重写最简单，也够原子。 */
function writeLedger(session, entries) {
	try {
		const path = join(ledgerDir(session), 'ledger.jsonl')
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, entries.length === 0 ? '' : `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
		return true
	} catch (error) {
		console.error(`dsh-compact-codex: 账本写入失败: ${String(error)}`)
		return false
	}
}

/**
 * 当前窗口号 = 1 + 会话里已发生的换窗次数。
 *
 * 按 `compaction/end` 事件计数。结果按会话缓存，换窗后失效。
 */
const windowCache = new WeakMap()

function windowOf(session) {
	const cached = windowCache.get(session)
	if (cached !== undefined) return cached
	const { compactions } = sessionDigestOf(session)
	const window = compactions + 1
	windowCache.set(session, window)
	return window
}

/**
 * 会话摘要缓存：`ledgerGate` / `ledgerHomeOf` / 冷缓存检查在同一个 pre-step 里
 * 最多各调一次 `snapshotEvents()`，而一次全量遍历在万级事件会话上要几十毫秒、
 * 还伴随整组数组的复制。这里把一次遍历的产物（窗口号、起点、真人请求、事件
 * 摘要）挂到会话上，`session.seq` 没动就直接复用。
 *
 * 弱引用 + 下一轮 tick 清理：agent 生命周期比插件长也无所谓，缓存跟着会话走。
 */
const digestCache = new WeakMap()

function sessionDigestOf(session) {
	const cached = digestCache.get(session)
	if (cached !== undefined && cached.atSeq === session.seq) return cached
	const out = { atSeq: session.seq, compactions: 0, lastCompactionSeq: 0, requests: [], events: [] }
	try {
		for (const event of session.snapshotEvents?.() ?? []) {
			out.events.push({ type: event.type, seq: event.seq, ts: event.time ?? 0 })
			if (event.type === 'compaction/end') {
				out.compactions += 1
				out.lastCompactionSeq = event.seq
			}
			if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
				const text = textOfContent(event.data?.content)
				if (text.trim() !== '') out.requests.push({ seq: event.seq, text, ts: event.time ?? 0 })
			}
		}
	} catch {
		// 拿不到事件（离线假 session）：当作第一个窗口、空列表。
	}
	digestCache.set(session, out)
	// 摘要变了，窗口号缓存必须跟着失效：旧实现只在 summarize() 里删，冷缓存换窗
	// 与基类内部触发的路径会让它停留在一个已过期的窗口号上。
	if (cached !== undefined) windowCache.delete(session)
	return out
}

/** 最近的用户请求（原话），账本主页与交接都要用。判据同 `assembleHandoff`：只认真人消息。 */
function personRequestsOf(session, limit) {
	return sessionDigestOf(session).requests.slice(-limit)
}

/** 会话事件的精简列表：换窗门槛只需 type / seq / ts 三样。 */
function eventDigest(session) {
	return sessionDigestOf(session).events
}

/** 本窗口的起点：最后一次换窗的编号；从未换过窗就是 0。 */
function windowStartSeq(session) {
	return sessionDigestOf(session).lastCompactionSeq
}

/**
 * 换窗门槛：账本够不够新。两道检查同时成立才放行：
 *
 * 1. 本窗口在最新一次用户请求之后记过账；
 * 2. 最近一次记账之后的工具结果不超过 N 个。
 *
 * 账本还空着时不拦。
 *
 * @returns 拒绝理由；`undefined` 表示放行。
 */
function ledgerGate(session) {
	const entries = readLedger(session)
	if (entries.length === 0) return undefined
	const digest = sessionDigestOf(session)
	const window = digest.compactions + 1
	const latest = digest.requests[digest.requests.length - 1]
	// 本窗口内没有任何真人请求时，第一道门槛没有判据：这种窗口里的工作都源自
	// 更早的请求，强行要求"在最近请求之后记账"只会拦住冷缓存换窗，没有保护意义。
	if (latest !== undefined && digest.lastCompactionSeq > latest.seq) return undefined
	if (!hasFreshEntry(entries, latest?.ts ?? 0, window)) {
		return '账本还不新：这个窗口里在最近一次用户请求之后还没有记过账。请先用 ledger_append 把已完成并有依据的进度、下一步和待改位置记进账本，再换窗口。'
	}
	const tail = tailOf(entries, digest.events, window, digest.lastCompactionSeq)
	if (tail.steps > DEFAULT_LEDGER_TAIL_STEPS) {
		const range = tail.from === undefined || tail.to === undefined ? '' : `（#${tail.from}–#${tail.to}）`
		return `账本还不新：最近一次记账（#L${tail.entrySeq}）之后又有 ${tail.steps} 个工具结果没有记进账本${range}。请先用 ledger_append 写明这些步骤的结论、下一步和待改位置，再换窗口。`
	}
	return undefined
}

/**
 * 最近一条记账之后、尚未记进账本的工具结果（旧→新），供换窗前自动快照归档。
 *
 * 与 `tailOf` 同一套覆盖判断，但保留每条的一句话摘要；条数上限同
 * `DEFAULT_LEDGER_TAIL_STEPS`，超出的部分只报数量。
 *
 * @returns `{ steps, briefs }`；briefs 每项 `{ seq, ts, brief }`。
 */
function unloggedStepsOf(session, entries) {
	const digest = sessionDigestOf(session)
	const window = digest.compactions + 1
	const latest = latestLedgerEntry(entries, window)
	const briefs = []
	let steps = 0
	for (const event of digest.events) {
		if (event.type !== 'tool/result' || event.seq <= digest.lastCompactionSeq) continue
		if (latest !== undefined) {
			const isCovered = typeof latest.through === 'number' ? event.seq <= latest.through : event.ts <= latest.ts
			if (isCovered) continue
		}
		steps += 1
		if (briefs.length >= DEFAULT_LEDGER_TAIL_STEPS) continue
		briefs.push({ seq: event.seq, ts: event.ts, brief: `工具结果（结果摘要需要时按 \`#${event.seq}\` 用 history 回查）` })
	}
	if (steps > briefs.length) {
		briefs.push({ seq: briefs[briefs.length - 1]?.seq ?? 0, ts: 0, brief: `（此前还有 ${steps - briefs.length} 个更早的未记账结果，从略）` })
	}
	return { steps, briefs }
}

/** 该窗口里 seq 最大的一条账本记录。 */
function latestLedgerEntry(entries, window) {
	let latest
	for (const entry of entries) {
		if (entry.window === window && (latest === undefined || entry.seq > latest.seq)) latest = entry
	}
	return latest
}

/** 表面上某个 `seq` 是不是一条用户消息（`request_ref` 的合法性判据）。 */
function isUserMessageEvent(session, seq) {
	const event = session.eventAt?.(seq)
	return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

/**
 * 账本主页：交给新窗口的那一页。
 * @returns 渲染好的文本；账本为空时返回 `''`（调用方据此退回旧版交接）。
 */
function ledgerHomeOf(session, options) {
	const entries = readLedger(session)
	if (entries.length === 0) return ''
	return renderHome(
		{ window: windowOf(session) + 1, entries, requests: personRequestsOf(session, options.requests) },
		{ maxTokens: Math.floor(options.maxTokens / 2), estimateTokens }
	)
}

/**
 * 注册账本工具 `ledger_append` / `ledger_read`。
 *
 * 校验逻辑在 `lib/ledger.js`；这里负责把它接上真实事件与文件系统。
 *
 * @param ctx - 插件 context（用它拿 `tools` 服务）。
 */
function registerLedgerTools(ctx) {
	/** 把会话里的事件整理成校验要用的形状。entries 由调用方传入：校验与追加共用一次读盘。 */
	const contextOf = (session, maxTextChars, entries) => ({
		entries,
		eventAt: (seq) => {
			try {
				return session.eventAt?.(seq)
			} catch {
				return undefined
			}
		},
		isUserMessage: (seq) => isUserMessageEvent(session, seq),
		maxTextChars,
		checkAnchor: (anchor) => checkAnchorOnDisk(anchor)
	})

	const tools = [
		{
			name: 'ledger_append',
			description:
				'向任务账本追加一条记录。每完成一个阶段写一条：task_id 标识任务（同一个任务的多条记录用同一个 id），'
				+ 'status 取 in_progress / done / superseded / blocked，text 用一句话说明这一步的要点。'
				+ '标 done 必须在 evidence 里给出证明它的工具结果编号（形如 #123 里的数字）。'
				+ '未完成的任务必须写 next_step，并用 anchors 记下接下来要改的位置：文件路径加一小段能在文件里唯一定位的原文。'
				+ 'next_step 与 anchors 省略表示沿用上一条，传空字符串或空数组表示清空。'
				+ '换窗口会丢掉没记进账本的东西，所以进度要及时记。',
			parameters: {
				type: 'object',
				additionalProperties: false,
				required: ['task_id', 'title', 'status', 'text'],
				properties: {
					task_id: { type: 'string' },
					title: { type: 'string' },
					status: { type: 'string', enum: ['in_progress', 'done', 'superseded', 'blocked'] },
					text: { type: 'string' },
					next_step: { type: 'string' },
					superseded_by: { type: 'string' },
					request_ref: { type: 'integer' },
					evidence: { type: 'array', items: { type: 'integer' } },
					anchors: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							required: ['path', 'match', 'note'],
							properties: {
								path: { type: 'string' },
								match: { type: 'string' },
								note: { type: 'string' }
							}
						}
					}
				}
			},
			output: {
				schema: { type: 'object', additionalProperties: false, required: ['detail'], properties: { detail: { type: 'string' } } },
				render: (_args, value) => [{ type: 'text', text: value.detail }]
			},
			async execute(args, exec) {
				const agent = exec.agent
				if (agent === undefined) throw new Error('ledger_append requires an owning agent session')
				const session = agent.session
				// 校验与追加共用一次读盘：账本几十条，重复读纯属浪费。
				const entries = readLedger(session)
				const problems = validateAppend(args, contextOf(session, DEFAULT_LEDGER_TEXT_CHARS, entries))
				if (problems.length > 0) {
					// 一次把话说完，模型可以一轮改完重试。
					throw new Error(`账本记录未通过校验：\n- ${problems.join('\n- ')}`)
				}
				const digest = sessionDigestOf(session)
				const latestRequest = digest.requests[digest.requests.length - 1]
				const entry = stampEntry(args, {
					seq: entries.reduce((top, item) => Math.max(top, Number(item.seq) || 0), 0) + 1,
					ts: Date.now(),
					window: digest.compactions + 1,
					defaultRequestSeq: latestRequest?.seq,
					through: session.seq
				})
				entries.push(entry)
				const isWritten = writeLedger(session, entries)
				const bound = entry.request_ref > 0 ? `#${entry.request_ref}` : '无'
				let detail = `已记录 #L${entry.seq}，对应请求 ${bound}。`
				if (!isWritten) detail += '\n注意：这次没能写进磁盘（内存里没有留存）；下次记账会重写整个文件。'
				return { detail }
			}
		},
		{
			name: 'ledger_read',
			description:
				'读任务账本。view 为 home（默认，主页概览：用户请求与未完成任务）、current（当前窗口的全部条目）、'
				+ '或 archive（归档页）；给 query 就在全部条目里按词搜索。',
			parameters: {
				type: 'object',
				additionalProperties: false,
				required: [],
				properties: {
					view: { type: 'string', enum: ['home', 'current', 'search'] },
					query: { type: 'string' }
				}
			},
			output: {
				schema: { type: 'object', additionalProperties: false, required: ['detail'], properties: { detail: { type: 'string' } } },
				render: (_args, value) => [{ type: 'text', text: value.detail }]
			},
			async execute(args, exec) {
				const agent = exec.agent
				if (agent === undefined) throw new Error('ledger_read requires an owning agent session')
				const session = agent.session
				const entries = readLedger(session)
				const view = typeof args?.view === 'string' ? args.view : 'home'
				const query = typeof args?.query === 'string' ? args.query.trim() : ''
				if (view === 'search' || query !== '') {
					if (query === '') throw new Error('搜索账本需要 query。')
					const needle = query.toLowerCase()
					const hit = entries.filter((entry) =>
						[entry.task_id, entry.title, entry.text, entry.next_step ?? ''].some(
							(field) => typeof field === 'string' && field.toLowerCase().includes(needle)
						)
					)
					return { detail: hit.length === 0 ? `账本里没有匹配「${query}」的条目。` : renderEntries(hit) }
				}
				if (view === 'current') return { detail: renderEntries(entries) }
				if (entries.length === 0) return { detail: '账本里还没有条目。当前是第 1 个窗口。' }
				return {
					detail: renderHome(
						{ window: windowOf(session), entries, requests: personRequestsOf(session, DEFAULT_HANDOFF_REQUESTS) },
						{ maxTokens: 8000, estimateTokens }
					)
				}
			}
		}
	]

	ctx.inject(['tools'], (toolsCtx) => {
		for (const tool of tools) {
			try {
				toolsCtx.tools.register(tool)
			} catch (error) {
				// 注册失败不能拖垮压缩本体。
				console.error(`dsh-compact-codex: ${tool.name} tool not registered: ${String(error)}`)
			}
		}
	})
}

/** 锚点能不能用：文件里找得到、且只出现一次。 */
function checkAnchorOnDisk(anchor) {
	let text
	try {
		text = readFileSync(anchor.path, 'utf8')
	} catch {
		return 'missing-file'
	}
	const haystack = text.replace(/\r\n/g, '\n')
	const needle = String(anchor.match).replace(/\r\n/g, '\n')
	if (needle === '') return 'no-match'
	const first = haystack.indexOf(needle)
	if (first === -1) return 'no-match'
	return haystack.indexOf(needle, first + 1) === -1 ? 'ok' : 'ambiguous'
}

/** 可检索历史。数据直接来自会话日志，不落盘。 */

/** 一次历史读取里，正文分页的默认与上限（字符数）。 */
const HISTORY_READ_DEFAULT = 4000
const HISTORY_READ_MAX = 20000
/** 搜索默认返回多少条、最多多少条。 */
const HISTORY_SEARCH_DEFAULT = 20
const HISTORY_SEARCH_MAX = 100
/** 摘录在匹配点两侧各取多少字符。 */
const HISTORY_EXCERPT_PAD = 80

/**
 * 给每一行标上它属于第几个窗口。窗口边界是 `compaction/end` 事件。
 *
 * @param events - 全部事件（要找 `compaction/end`）。
 * @returns `{ bounds, of }`：`bounds[i]` 是第 i+1 个窗口的起始 seq，`of(seq)` 返回窗口号。
 */
function windowIndex(events) {
	const bounds = []
	for (const event of events) {
		if (event.type === 'compaction/end') bounds.push(event.seq)
	}
	const of = (seq) => {
		let window = 1
		for (const bound of bounds) {
			if (seq > bound) window += 1
		}
		return window
	}
	return { bounds, of, count: bounds.length + 1 }
}

/**
 * 把会话事件整理成可搜索的行。
 *
 * 先扫一遍 `tool/call` 建 `callId → { name, arguments }` 索引，供结果关联回调用。
 *
 * @param session - 提供事件读取的会话。
 * @returns 按 seq 升序的行。
 */
function historyRowsOf(session) {
	const rows = []
	let events = []
	try {
		events = [...(session.snapshotEvents?.() ?? [])]
	} catch {
		// 拿不到事件就当空历史：搜索会如实说"没有匹配"，不会抛。
		return rows
	}
	const windows = windowIndex(events)

	const calls = new Map()
	for (const event of events) {
		if (event.type !== 'tool/call') continue
		const callId = event.data?.callId
		if (typeof callId === 'string' && callId !== '') {
			calls.set(callId, { name: event.data?.name, arguments: event.data?.arguments })
		}
	}

	for (const event of events) {
		const ts = event.time ?? 0
		const window = windows.of(event.seq)
		if (event.type === 'user/message') {
			// 只收真人消息：同一条通道上还走着本插件的预算读数、技能目录、运行时上下文。
			if (event.data?.source?.kind !== 'user') continue
			const text = textOfContent(event.data?.content)
			if (text.trim() === '') continue
			rows.push({ seq: event.seq, ts, role: 'user', window, text })
			continue
		}
		if (event.type === 'assistant/message') {
			const blocks = event.data?.message?.content ?? []
			const text = blocks
				.filter((block) => block?.type === 'text' && typeof block.text === 'string')
				.map((block) => block.text)
				.join('\n')
			if (text.trim() === '') continue
			rows.push({ seq: event.seq, ts, role: 'assistant', window, text })
			continue
		}
		if (event.type === 'tool/result') {
			const message = event.data?.message ?? {}
			// 关联回它的调用：两个字段名都试，不同路径写进去的不一样。
			const callId = typeof message.toolCallId === 'string'
				? message.toolCallId
				: (typeof message.source?.callId === 'string' ? message.source.callId : undefined)
			const call = callId === undefined ? undefined : calls.get(callId)
			const path = event.data?.meta?.diffs?.find((diff) => typeof diff?.path === 'string')?.path
			rows.push({
				seq: event.seq,
				ts,
				role: 'tool',
				window,
				tool: call?.name,
				args: call?.arguments,
				path,
				isError: message.isError === true,
				text: textOfContent(message.content)
			})
		}
	}
	return rows
}

/** 一行渲染成搜索结果的一行：编号、窗口、角色、工具、路径，然后是摘录。 */
function renderHistoryHit(row, excerpt) {
	const bits = [`\`#${row.seq}\``]
	if (row.window !== undefined) bits.push(`W${row.window}`)
	bits.push(row.role)
	if (row.tool !== undefined) bits.push(`[${row.tool}]`)
	if (row.path !== undefined) bits.push(`[${row.path}]`)
	if (row.isError === true) bits.push('(失败)')
	const brief = typeof row.args === 'string' && row.args !== '' ? ` ${clip(row.args, 120)}` : ''
	return `- ${bits.join(' ')}${brief}：${excerpt}`
}

/**
 * 注册 `history` 工具。
 * @param ctx - 插件 context（用它拿 `tools` 服务）。
 */
function registerHistoryTool(ctx) {
	const tool = {
		name: 'history',
		description:
			'检索或读取完整历史。action 为 search 时按条件查历史编号，为 read 时按编号读原文。'
			+ '交接信息与工具结果里形如 #123 的就是历史编号。'
			+ '读原文时 field 填 input 可以看到那次工具调用的完整参数（完整命令、搜索模式、子任务原文）。'
			+ '**之前跑过的命令、读过的文件，输出都在历史里**：需要时先 search 再 read，不要重跑同样的探测命令。'
			+ '搜索默认返回最新若干条；不指定 role 就查全部角色。window 是第几次上下文窗口（换窗会把编号区间切成若干窗口，按它搜可以只看某个窗口里发生的事）。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['action'],
			properties: {
				action: { type: 'string', enum: ['search', 'read'] },
				query: { type: 'string' },
				role: { type: 'string', enum: ['user', 'assistant', 'tool'] },
				tool_name: { type: 'string' },
				path: { type: 'string' },
				window: { type: 'integer' },
				limit: { type: 'integer' },
				seq: { type: 'integer' },
				field: { type: 'string', enum: ['text', 'input'] },
				offset: { type: 'integer' },
				length: { type: 'integer' }
			}
		},
		output: {
			schema: { type: 'object', additionalProperties: false, required: ['detail'], properties: { detail: { type: 'string' } } },
			render: (_args, value) => [{ type: 'text', text: value.detail }]
		},
		async execute(args, exec) {
			const agent = exec.agent
			if (agent === undefined) throw new Error('history requires an owning agent session')
			const rows = historyRowsOf(agent.session)
			const action = args?.action

			if (action === 'search') {
				return { detail: searchHistoryRows(rows, args) }
			}
			if (action === 'read') {
				return { detail: readHistoryRow(rows, args) }
			}
			throw new Error('history 工具需要 action："search" 或 "read"。')
		}
	}

	ctx.inject(['tools'], (toolsCtx) => {
		try {
			toolsCtx.tools.register(tool)
		} catch (error) {
			console.error(`dsh-compact-codex: history tool not registered: ${String(error)}`)
		}
	})
}

/**
 * 搜索历史行。
 *
 * 每个过滤字段都防御性读取：值类型不对就当作没有这个过滤。空 query 只应用过滤条件。
 */
function searchHistoryRows(rows, args) {
	const raw = args ?? {}
	// limit 取有限正整数，否则用默认值。
	const limit = typeof raw.limit === 'number' && Number.isFinite(raw.limit) && raw.limit >= 1
		? Math.min(Math.floor(raw.limit), HISTORY_SEARCH_MAX)
		: HISTORY_SEARCH_DEFAULT
	const role = raw.role === 'user' || raw.role === 'assistant' || raw.role === 'tool' ? raw.role : undefined
	// 窗口号：第几次上下文窗口。边界就是换窗事件，所以不用另存。
	const wantedWindow = typeof raw.window === 'number' && Number.isInteger(raw.window) && raw.window >= 1
		? raw.window
		: undefined
	const toolName = typeof raw.tool_name === 'string' && raw.tool_name !== '' ? raw.tool_name : undefined
	const pathNeedle = typeof raw.path === 'string' && raw.path !== '' ? raw.path.replace(/\\/g, '/').toLowerCase() : undefined
	const needle = typeof raw.query === 'string' ? raw.query.toLowerCase() : ''

	const hits = []
	// 最新优先：要找的通常是刚刚发生的事。
	for (let index = rows.length - 1; index >= 0 && hits.length < limit; index -= 1) {
		const row = rows[index]
		if (role !== undefined && row.role !== role) continue
		if (wantedWindow !== undefined && row.window !== wantedWindow) continue
		if (toolName !== undefined && row.tool !== toolName) continue
		if (pathNeedle !== undefined) {
			if (typeof row.path !== 'string' || !row.path.replace(/\\/g, '/').toLowerCase().includes(pathNeedle)) continue
		}

		let excerpt
		if (needle === '') {
			excerpt = clip((row.text || '').replace(/\s+/g, ' '), 160)
		} else {
			// 正文、调用参数、工具名、路径都查：按路径或命令找到一次旧调用，正是它存在的意义。
			const fields = [
				{ text: row.text || '', kind: 'text' },
				{ text: row.args || '', kind: 'input' },
				{ text: row.tool || '', kind: 'tool' },
				{ text: row.path || '', kind: 'path' }
			]
			let at = -1
			let field
			for (const candidate of fields) {
				at = candidate.text.toLowerCase().indexOf(needle)
				if (at !== -1) {
					field = candidate
					break
				}
			}
			if (field === undefined) continue
			const from = Math.max(0, at - HISTORY_EXCERPT_PAD)
			const to = Math.min(field.text.length, at + needle.length + HISTORY_EXCERPT_PAD)
			const marked = field.kind === 'text' ? '' : `（命中${field.kind === 'input' ? '调用参数' : field.kind === 'tool' ? '工具名' : '路径'}）`
			excerpt = `${marked}${field.text.slice(from, to).replace(/\s+/g, ' ')}`
		}
		hits.push(renderHistoryHit(row, excerpt))
	}

	if (hits.length === 0) {
		return needle === ''
			? '没有匹配。'
			: `没有匹配「${raw.query}」。可以换一个词，或去掉 role / window / tool_name / path 过滤再试。`
	}
	// 这里报的是「返回了几条」而不是「一共匹配几条」：打满上限时条数不等于匹配总数。
	const head = hits.length >= limit
		? `返回 ${hits.length} 条（已达到上限 ${limit}，可能还有更早的；要看更多请调大 limit）`
		: `返回 ${hits.length} 条`
	return [head, ...hits].join('\n')
}

/**
 * 按编号读一行的原文，支持分页。`field: "input"` 读那次工具调用的完整参数。
 */
function readHistoryRow(rows, args) {
	const raw = args ?? {}
	const seq = typeof raw.seq === 'number' && Number.isInteger(raw.seq) ? raw.seq : undefined
	if (seq === undefined) throw new Error('history read 需要 seq：用 history search 查到的历史编号。')
	const row = rows.find((candidate) => candidate.seq === seq)
	if (row === undefined) throw new Error(`历史里没有 #${seq} 这条记录。`)

	const isInput = raw.field === 'input'
	const body = isInput ? (typeof row.args === 'string' ? row.args : '') : (row.text || '')
	if (isInput && body === '') {
		throw new Error(`#${seq} 没有留下调用参数。（它可能是 ${row.role} 行，或那次调用的参数没有被记录。）`)
	}
	const offset = typeof raw.offset === 'number' && Number.isFinite(raw.offset) ? Math.max(0, Math.floor(raw.offset)) : 0
	const asked = typeof raw.length === 'number' && Number.isFinite(raw.length) ? Math.floor(raw.length) : HISTORY_READ_DEFAULT
	const length = Math.max(0, Math.min(asked, HISTORY_READ_MAX))
	const end = Math.min(body.length, offset + length)
	const hasMore = end < body.length

	const head = [
		`\`#${seq}\``,
		row.window === undefined ? '' : `W${row.window}`,
		row.role,
		row.tool === undefined ? '' : `[${row.tool}]`,
		row.path === undefined ? '' : `[${row.path}]`,
		row.isError === true ? '(失败)' : '',
		isInput ? '调用参数' : '',
		`共 ${body.length} 字符`,
		hasMore ? `，还有后续，用 offset ${end} 继续读` : ''
	].filter((part) => part !== '').join(' ')
	return `${head}\n${body.slice(offset, end)}`
}

/**
 * 缓存观测与保活。
 *
 * 观测：从 `ctx.tokenMeter` 的 baseline 读 `cacheReadTokens` / `cacheWriteTokens`，
 * 得到缓存前缀的规模与冷热。
 * 保活：会话空闲时发一次只回一个 token 的请求，维持缓存命中；默认开启，可用
 * `keepalive: false` 关闭。
 */
function registerCacheKeeper(ctx, engine, config) {
	/** 见过的会话 → 它的 agent。周期检查靠它遍历。 */
	// WeakRef：agent 对象不该被插件钉在内存里。dsh 每回合都会新建 agent，旧实现
	// 用普通 Map 按会话强引用每一个，长会话进程里废 agent 越攒越多（泄漏）。
	// 收集时机由保活周期兜底：每次 tick 先清一遍死引用，活引用按需回填。
	const watchedAgents = new Map()
	const stateOf = (session) => {
		let state = cacheStates.get(session)
		if (state === undefined) {
			state = initialCacheState()
			cacheStates.set(session, state)
		}
		return state
	}

	const options = {
		enabled: config.keepalive,
		ttlMs: config.cacheTtlMs,
		keepaliveAfterMs: config.keepaliveAfterMs,
		minCacheReadTokens: config.minCacheReadTokens,
		idleKeepaliveBudget: config.idleKeepaliveBudget,
		maxConsecutiveFailures: config.maxConsecutiveFailures,
		coldSwitch: config.coldSwitch,
		coldMinTokens: config.coldMinTokens,
		checkEveryMs: config.checkEveryMs
	}
	// 读数注入在别的钩子里也要用同一份阈值，所以放模块级。
	cacheOptions = options

	/** 上一次请求的用量里带着缓存数据，那就是更新的来源。 */
	const observe = (session, agent) => {
		if (agent !== undefined) watchedAgents.set(session, new WeakRef(agent))
		try {
			const measurement = ctx.tokenMeter?.measure(session)
			const usage = measurement?.baseline?.kind === 'usage' ? measurement.baseline.usage : undefined
			if (usage === undefined) return
			noteRequest(stateOf(session), usage, Date.now())
		} catch {
			// 观测失败不该影响任何东西。
		}
	}


	ctx.on('agent/pre-step', async ({ agent }, next) => {
		observe(agent.session, agent)
		return next()
	}, { prepend: true })

	/** 发一次保活：原样回放当前请求的前缀，只追加一句极短的指令，让模型回一个 token。 */
	const fire = async (agent) => {
		const session = agent.session
		const state = stateOf(session)
		// 先占位再发：计数与在飞标志都必须在 await 之前定下，否则并发的检查周期会各发一次。
		if (state.inFlight) return
		// header 拿不到就别占预算：旧实现在这里照样 `idleKeepalives += 1`，然后一个
		// 请求都不发，纯烧掉一次空闲预算。
		const header = session.requestHeader?.()
		if (header === undefined) return
		state.inFlight = true
		state.idleKeepalives += 1
		try {
			const messages = session.deriveMessages?.()
			if (messages === undefined) return
			const keep = [...messages, createUserMessage({ content: [{ type: 'text', text: 'OK' }], source: { kind: SOURCE_KIND } })]
			const request = {
				...header.config,
				messages: keep,
				// 工具定义必须跟着走：它们排在请求最前面，属于缓存前缀的一部分。
				// 漏掉时命中的前缀会短一截，省下的读被一次重写吃掉。
				...(header.tools !== undefined ? { tools: header.tools } : {}),
				...(typeof session.toolHistory === 'function' ? { toolHistory: session.toolHistory() } : {}),
				sessionId: session.id,
				maxTokens: 1,
				signal: AbortSignal.timeout(60_000)
			}
			// 只要它跑完：这次调用的意义是让 provider 那边重新计时，输出内容无关。
			// 但**读了缓存还是重写了**必须看得出来——那是保活成败的唯一判据。
			let usage
			for await (const chunk of ctx.llm.stream(request)) {
				if (chunk?.usage !== undefined) usage = chunk.usage
			}
			state.lastActivityAt = Date.now()
			state.consecutiveFailures = 0
			const read = usage?.cacheReadTokens ?? usage?.cache_read_input_tokens
			const write = usage?.cacheWriteTokens ?? usage?.cache_creation_input_tokens
			console.error(
				`dsh-compact-codex: 缓存保活已发出（第 ${state.idleKeepalives} 次）；`
				+ `读缓存 ${read ?? '未报'}、写缓存 ${write ?? '未报'}`
				+ (read === undefined && write === undefined ? '（provider 未在使用量里报缓存字段）' : '')
			)
		} catch (error) {
			state.consecutiveFailures += 1
			console.error(`dsh-compact-codex: 缓存保活失败（第 ${state.consecutiveFailures} 次）: ${String(error)}`)
		} finally {
			// 无论成败都要放开：卡住的话保活就永久停了。
			state.inFlight = false
		}
	}

	/** 空闲后按需保活。 */
	const schedule = (agent) => {
		if (!options.enabled) return
		const session = agent.session
		const decision = decideKeepalive(stateOf(session), Date.now(), options, false)
		if (decision.action === 'fire') void fire(agent)
	}

	/** 保活检查的周期定时器（另有 `agent/status` 的 idle 事件补一次机会）。 */
	const ticker = setInterval(() => {
		// 先清死引用：会话对象本身由 cacheStates 的 WeakMap 弱持有，GC 只会收走
		// 已结束的会话；把它们的条目一并丢掉，防止 Map 无界增长。
		for (const [session, ref] of watchedAgents) {
			if (ref.deref() === undefined) watchedAgents.delete(session)
		}
		for (const ref of watchedAgents.values()) {
			const agent = ref.deref()
			if (agent !== undefined) schedule(agent)
		}
	}, options.checkEveryMs)
	ticker.unref?.()

	ctx.on('agent/status', ({ agent, status }) => {
		if (status === 'idle') schedule(agent)
	})

	/**
	 * 冷缓存时主动换窗。
	 *
	 * 在 `agent/pre-step` 检查缓存是否已过期；门槛满足时调 `compactRegion` 换窗，
	 * 不发起模型调用。
	 */
	ctx.on('agent/pre-step', async ({ agent }, next) => {
		const decision = await next()
		if (decision.kind === 'reject') return decision
		if (!options.coldSwitch) return decision
		const session = agent.session
		const state = stateOf(session)
		// 还没有基线，谈不上冷热。
		if (state.lastActivityAt === null) return decision
		// 缓存还活着：这时换窗要先付一次重写，不划算。
		if (Date.now() - state.lastActivityAt < options.ttlMs) return decision
		let tokens
		try {
			tokens = ctx.tokenMeter.measure(session).totalTokens
		} catch {
			return decision
		}
		// 上下文低于下限时，重写前缀的代价与换窗本身相当。
		if (tokens < options.coldMinTokens) return decision
		// 账本不新就不换：换窗会丢掉没记下来的东西。门槛通过只说明「最近 25 个
		// 结果之内有记账」，不等于账本与现状对齐——与压力换窗同款，先落自动快照
		// 再换，让新窗口的账本时间线盖到当前 seq。
		if (ledgerGate(session) !== undefined) return decision
		const nodes = session.surface.nodes
		const head = session.eventAt(nodes[0])
		const startIdx = head?.type === 'system/message' ? 1 : 0
		const endIdx = nodes.length - 1
		if (endIdx <= startIdx) return decision
		try {
			writeAutoSnapshot(session)
		} catch (error) {
			console.error(`dsh-compact-codex: 冷缓存换窗前自动快照失败: ${String(error)}`)
		}
		try {
			await engine.compactRegion(nodes[startIdx], nodes[endIdx], agent)
		} catch (error) {
			console.error(`dsh-compact-codex: 冷缓存换窗失败: ${String(error)}`)
		}
		return decision
	}, { prepend: true })
}

/**
 * 一次性诊断：把 Loader 条目与客户端启动图写到 $DSH_HOME/dsh-compact-codex-diag.json。
 */
function writeClientDiagnostics(ctx) {
	try {
		const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
		const pick = (holder, name) => {
			try {
				return typeof holder?.get === 'function' ? holder.get(name) : undefined
			} catch {
				return undefined
			}
		}
		const out = { at: new Date().toISOString(), self: 'dsh-compact-codex' }
		const loader = pick(ctx, 'loader') ?? pick(ctx.root, 'loader')
		if (loader !== undefined && typeof loader.entries === 'function') {
			out.loaderEntries = [...loader.entries()].map((entry) => entry.options?.name).filter((name) => typeof name === 'string')
		}
		for (const [label, holder] of [['ctx', ctx], ['ctx.root', ctx.root]]) {
			const clientModules = pick(holder, 'clientModules')
			if (clientModules === undefined) {
				out[label] = { clientModules: 'absent' }
				continue
			}
			let graphText = ''
			try {
				graphText = JSON.stringify(typeof clientModules.graph === 'function' ? clientModules.graph() : null)
			} catch (error) {
				graphText = `graph() threw: ${error.message}`
			}
			out[label] = {
				clientModules: 'present',
				mentionsSelf: graphText.includes('dsh-compact-codex'),
				graphLength: graphText.length,
				rowsSeen: [...graphText.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]).slice(0, 60)
			}
		}
		writeFileSync(join(home, 'dsh-compact-codex-diag.json'), JSON.stringify(out, null, 2), 'utf8')
	} catch {
		// 诊断本身失败时静默：它不能影响压后端。
	}
}

var CodexCompactionEngine = class extends BasicCompactionEngine {
	static inject = ['llm', 'tokenMeter', 'sessions']

	/**
	 * 配置声明：基类的全部字段，加上本插件自有的几个。
	 *
	 * 不能沿用基类的 `Config`：Schemastery 会剥离未声明的字段。基类新增字段时这里要同步。
	 */
	static Config = z.object({
		style: z.string(),
		handoffTokens: z.number().step(1).min(1),
		budgetContext: z.boolean(),
		budgetRefreshMs: z.number().step(1).min(0),
		// 缓存保活：默认开启。它会发真实请求消耗额度，不需要时显式关掉。
		keepalive: z.boolean(),
		cacheTtlMs: z.number().step(1).min(1000),
		keepaliveAfterMs: z.number().step(1).min(1000),
		minCacheReadTokens: z.number().step(1).min(0),
		idleKeepaliveBudget: z.number().step(1).min(0),
		maxConsecutiveFailures: z.number().step(1).min(1),
		// 冷缓存时主动换窗：不调模型，所以默认开着。
		coldSwitch: z.boolean(),
		coldMinTokens: z.number().step(1).min(0),
		checkEveryMs: z.number().step(1).min(1000),
		thresholdRatio: z.number(),
		headroomTokens: z.number().step(1).min(0),
		retainRatio: z.number(),
		retainTokens: z.number().step(1).min(0),
		summarizationProvider: z.string(),
		summarizationModel: z.string(),
		maxTokens: z.number().step(1).min(1),
		compactionRetries: z.number().step(1).min(0),
		maxOverflowRetries: z.number().step(1).min(0),
		modelPolicies: z.array(z.object({
			provider: z.string().required(),
			model: z.string().required(),
			thresholdRatio: z.number(),
			headroomTokens: z.number().step(1).min(0),
			retainRatio: z.number(),
			retainTokens: z.number().step(1).min(0),
			summarizationProvider: z.string(),
			summarizationModel: z.string(),
			maxTokens: z.number().step(1).min(1),
			compactionRetries: z.number().step(1).min(0),
			maxOverflowRetries: z.number().step(1).min(0)
		})),
		auto: z.boolean()
	})

	constructor(ctx, config = {}) {
		// 自有字段必须先摘掉：基类的 resolveConfig 会拒绝未知键。
		const { style, handoffTokens, budgetContext, budgetRefreshMs, keepalive, cacheTtlMs, keepaliveAfterMs, minCacheReadTokens, idleKeepaliveBudget, maxConsecutiveFailures, coldSwitch, coldMinTokens, checkEveryMs, ...baseConfig } = config
		super(ctx, baseConfig)
		// 插件在场就一律换窗：不再有 summary 这条路。
		//
		// 两件事一起定下这个决定：一是 Codex 的 token-budget 形态本来就是纯换窗
		// （`Feature::TokenBudget` 开启时 skips model/server summarization and installs a
		// fresh context window）；二是引擎自带的摘要压缩已经由本插件接管，所以留下一个
		// "本插件也写摘要"的模式只会让两种压缩混在一起。要摘要就卸载本插件。
		if (style !== undefined && style !== 'reset') {
			throw new Error(`dsh-compact-codex: 本插件只做换窗，style 只能是 "reset"（收到 ${JSON.stringify(style)}）；需要摘要压缩请卸载本插件，用引擎自带的实现`)
		}
		this.handoffOptions = {
			maxTokens: handoffTokens ?? DEFAULT_HANDOFF_TOKENS,
			actions: DEFAULT_HANDOFF_ACTIONS,
			requests: DEFAULT_HANDOFF_REQUESTS,
			files: DEFAULT_HANDOFF_FILES
		}
		registerBudgetContext(ctx, this.config, {
			budgetContext: budgetContext ?? true,
			refreshMs: budgetRefreshMs ?? DEFAULT_BUDGET_REFRESH_MS
		})
		writeClientDiagnostics(ctx)
		registerNewContextTool(ctx, this)
		registerLedgerTools(ctx)
		registerHistoryTool(ctx)
		registerCacheKeeper(ctx, this, {
			// 保活默认开启。观测部分不受这个开关影响，一直在跑。
			keepalive: keepalive ?? true,
			cacheTtlMs: cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
			keepaliveAfterMs: keepaliveAfterMs ?? DEFAULT_KEEPALIVE_AFTER_MS,
			minCacheReadTokens: minCacheReadTokens ?? DEFAULT_MIN_CACHE_READ_TOKENS,
			idleKeepaliveBudget: idleKeepaliveBudget ?? DEFAULT_IDLE_KEEPALIVE_BUDGET,
			maxConsecutiveFailures: maxConsecutiveFailures ?? DEFAULT_MAX_KEEPALIVE_FAILURES,
			// 冷缓存时主动换窗：不调模型，所以默认开。
			coldSwitch: coldSwitch ?? true,
			coldMinTokens: coldMinTokens ?? DEFAULT_COLD_MIN_TOKENS,
			checkEveryMs: checkEveryMs ?? DEFAULT_KEEPALIVE_CHECK_MS
		})
	}

	/**
	 * 基类公开的唯一子类钩子供体。返回的 `summary` 文本块会被基类包进
	 * `<compacted-summary>` 检查点，作为一条替换型 `user/message` 落地。
	 * 自动压力路径与 `new_context` 都经由这一个钩子。
	 */
	async summarize(_input, agent, _signal) {
		const summary = resetSummary(this.config, agent, this.handoffOptions)
		// 这次换窗完成后 `compaction/end` 会多一条，窗口号随之变化：清掉缓存让它下次重算。
		windowCache.delete(agent.session)
		return summary
	}
}

export { CodexCompactionEngine, CodexCompactionEngine as default }
/** 仅供离线验证脚本使用；不属于插件对外接口。 */
export const __test = { resolveBudgetSpec, renderBudgetText, resolveSummaryTarget, assembleHandoff, estimateTokens, registerNewContextTool, registerLedgerTools, registerHistoryTool, ledgerGate, readLedger, writeLedger, windowOf, historyRowsOf, searchHistoryRows, readHistoryRow, sessionDigestOf, unloggedStepsOf, writeAutoSnapshot, ledgerHomeOf }
