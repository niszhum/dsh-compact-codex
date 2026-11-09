/**
 * 交接信息与账本的离线断言：不依赖真实会话日志，也不启动 dsh。
 *
 * 跑法：在仓库根目录 `node --test test/handoff.test.mjs`。需要 node_modules 里的运行时包
 * （联接命令见 docs/internals.md 的「依赖解析」），否则 lib/index.js 的 import 解析不到。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../lib/index.js'
import { appendAutoSnapshot, renderHome, stampEntry, tasksOf, validateAppend } from '../lib/ledger.js'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 造一个最小会话：surface 只含当前窗口的节点，日志保留全部事件。 */
function sessionOf(events, surfaceFromSeq) {
	const bySeq = new Map(events.map((event) => [event.seq, event]))
	return {
		id: 'test-session',
		seq: events[events.length - 1].seq,
		surface: { nodes: events.filter((event) => event.seq > surfaceFromSeq).map((event) => event.seq) },
		eventAt: (seq) => bySeq.get(seq),
		snapshotEvents: () => events,
		requestHeader: () => undefined
	}
}

/** 造事件流：任务起点 + 若干后续请求 + 一次换窗 + 一条动作。 */
function buildSession() {
	const events = []
	let seq = 1
	const push = (type, data) => { const event = { type, seq: seq++, data, time: 1000 + seq }; events.push(event); return event }
	push('system/message', { content: [{ type: 'text', text: 'sys' }] })
	const ask = (text) => push('user/message', { source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text }] })
	ask('把 fetch 层改成指数退避重试：最多 5 次、基数 200ms、带抖动，并补上单元测试。不要改动调用方签名。')
	ask('顺便把日志级别改成 debug')
	ask('再补一条集成测试')
	ask('继续')
	const compactionSeq = seq - 1
	push('compaction/end', {})
	ask('接着做')
	push('assistant/message', { message: { content: [{ type: 'text', text: '测试通过，还剩抖动参数要确认。' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"node --test"}' }] } })
	push('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: '12 tests passed' }], isError: false } })
	return { events, session: sessionOf(events, compactionSeq) }
}

/** 造一个只含三条动作的会话：一条真动作、一条记账、一次换窗。 */
function snapshotSession() {
	const events = []
	let seq = 1
	const push = (type, data) => { const event = { type, seq: seq++, data, time: 1000 + seq }; events.push(event); return event }
	push('system/message', { content: [{ type: 'text', text: 'sys' }] })
	push('user/message', { source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text: '把这些步骤做完' }] })
	const act = (id, name, args, result) => {
		push('assistant/message', { message: { content: [{ type: 'tool-call', id, name, arguments: args }] } })
		push('tool/result', { message: { toolCallId: id, content: [{ type: 'text', text: result }], isError: false } })
	}
	act('c1', 'bash', '{"command":"node --test"}', '12 tests passed')
	act('c2', 'run_code', 'const r = await tools.ledger_append({ task_id: "t1" })', '已记录 #L1')
	act('c3', 'run_code', 'await tools.new_context({})', 'A new context window will start without summarizing conversation history.')
	// eventAt 是构造时的快照，必须等事件全部入列后再建会话。
	return { events, session: sessionOf(events, 0) }
}

const options = { maxTokens: 15000, actions: 12, requests: 3, files: 12, ledger: '' }

test('换窗后任务起点仍在交接信息里', () => {
	const { session } = buildSession()
	const handoff = __test.assembleHandoff(session, options)
	assert.match(handoff, /## 任务起点/)
	assert.ok(handoff.includes('指数退避重试'), '首个请求的原文必须出现')
	assert.ok(handoff.includes('不要改动调用方签名'), '验收要求必须出现')
})

test('请求轨迹列出全部请求，而不是最近三条', () => {
	const { session } = buildSession()
	const handoff = __test.assembleHandoff(session, options)
	for (const text of ['日志级别改成 debug', '再补一条集成测试', '继续', '接着做']) {
		assert.ok(handoff.includes(text), '缺少请求：' + text)
	}
})

test('预算紧张时先砍动作，任务起点不丢', () => {
	const { session } = buildSession()
	const handoff = __test.assembleHandoff(session, { ...options, maxTokens: 120, requests: 3 })
	assert.ok(handoff.includes('指数退避重试'), '任务起点是保底段，不能被砍')
	assert.ok(!handoff.includes('12 tests passed'), '动作段应最先被砍掉')
})

test('PTC 里的 tools.ledger_append 不算工作动作', () => {
	assert.ok(__test.isSelfReferentialCall('const r = await tools.ledger_append({ task_id: "t" })'))
	assert.ok(__test.isSelfReferentialCall('tools.new_context({})'))
	assert.ok(!__test.isSelfReferentialCall('const r = await tools.bash({ command: "ls" })'))
})

test('PTC 写路径能进文件工作集，读路径不进去', () => {
	assert.deepEqual(__test.filePathsOf('{"file_path":"src/a.js","content":"x"}'), ['src/a.js'])
	assert.deepEqual(__test.filePathsOf('{"file_path":"src/a.js"}'), [], '纯读不应计入工作集')
	assert.deepEqual(__test.filePathsOf('await tools.write({ file_path: "src/b.js", content: "y" })'), ['src/b.js'])
})

test('done_when 的校验、落盘、继承与渲染', () => {
	const context = { entries: [], eventAt: () => ({ type: 'tool/result', data: { message: { isError: false } } }), isUserMessage: () => true, maxTextChars: 1500, checkAnchor: () => 'ok' }
	assert.ok(validateAppend({ task_id: 't1', title: 'T', status: 'in_progress', text: 'x', next_step: 'y', done_when: 1 }, context).some((p) => p.includes('done_when')))
	assert.ok(validateAppend({ task_id: 't1', title: 'T', status: 'in_progress', text: 'x', next_step: 'y', done_when: 'z'.repeat(401) }, context).some((p) => p.includes('done_when')))
	const entry = stampEntry({ task_id: 't1', title: 'T', status: 'in_progress', text: 'x', next_step: 'y', done_when: '所有测试绿且抖动参数已定' }, { seq: 1, ts: 100, window: 2, through: 50 })
	assert.equal(tasksOf([entry])[0].doneWhen.value, '所有测试绿且抖动参数已定')
	const home = renderHome({ window: 2, entries: [entry], requests: [] }, { maxTokens: 8000, estimateTokens: __test.estimateTokens })
	assert.ok(home.includes('完成判据：所有测试绿且抖动参数已定'))
	assert.ok(!home.includes('最近的用户请求'), '没有请求时不渲染空段')
})

test('账本记录渲染回应请求编号', () => {
	const entry = stampEntry({ task_id: 't1', title: 'T', status: 'in_progress', text: 'x', next_step: 'y' }, { seq: 1, ts: 100, window: 2, through: 50, defaultRequestSeq: 42 })
	const home = renderHome({ window: 2, entries: [entry], requests: [] }, { maxTokens: 8000, estimateTokens: __test.estimateTokens })
	assert.ok(home.includes('#42'), '应显示这条记录回应的请求编号')
})
test('换窗前的自动快照记的是工具名与参数，不是结果首行', () => {
	const { session } = snapshotSession()
	const { briefs } = __test.unloggedStepsOf(session, [])
	assert.equal(briefs[0].brief, 'bash：node --test')
})

test('自指动作与换窗不进自动快照', () => {
	const { session } = snapshotSession()
	const { steps, briefs } = __test.unloggedStepsOf(session, [])
	assert.equal(steps, 3, '三条工具结果都算未记账：门槛按结果数算，不按摘要数')
	assert.deepEqual(briefs.map((item) => item.brief), ['bash：node --test'], '只有真正的动作进摘要')
})

test('没有可归档的动作时快照只写数量，不留空表头', () => {
	const meta = { seq: 1, ts: 100, window: 2, through: 90, requestRef: 5 }
	const { appended } = appendAutoSnapshot([], [], meta, 2)
	assert.ok(appended.text.includes('最近 2 个工具结果未记账'))
	assert.ok(!appended.text.includes('已由系统归档'), '空列表不该留一个空表头')
})

test('done_when 省略时沿用上一条并标记为继承', () => {
	const first = stampEntry({ task_id: 't1', title: 'T', status: 'in_progress', text: 'a', next_step: 'n1', done_when: '判据A' }, { seq: 1, ts: 100, window: 1 })
	const second = stampEntry({ task_id: 't1', title: 'T', status: 'in_progress', text: 'b', next_step: 'n2' }, { seq: 2, ts: 200, window: 2 })
	const task = tasksOf([first, second])[0]
	assert.equal(task.doneWhen.value, '判据A')
	assert.equal(task.doneWhen.isInherited, true)
})

// 守的是「不留残留临时文件、整本覆盖」；rename 的原子性靠语义与代码审查，测试测不出来。
test('账本落盘是原子替换：不留临时文件，第二次写入整本覆盖', () => {
	const home = mkdtempSync(join(tmpdir(), 'dsh-ledger-'))
	const previous = process.env.DSH_HOME
	process.env.DSH_HOME = home
	try {
		const session = { id: 'session-atomic' }
		const first = [{ task_id: 't', title: 'T', status: 'in_progress', text: '第一版', seq: 1, ts: 1, window: 1, request_ref: 0 }]
		const second = [...first, { task_id: 't', title: 'T', status: 'done', text: '第二版', seq: 2, ts: 2, window: 1, request_ref: 0, evidence: [1] }]
		assert.equal(__test.writeLedger(session, first), true)
		assert.equal(__test.writeLedger(session, second), true)
		const dir = join(home, 'dsh-compact-codex', 'sessions', 'session-atomic')
		assert.deepEqual(readdirSync(dir), ['ledger.jsonl'], '只应有账本本体')
		const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n')
		assert.equal(lines.length, 2, '第二次写入是整本覆盖，不是追加')
		assert.ok(lines[1].includes('第二版'))
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previous
		rmSync(home, { recursive: true, force: true })
	}
})

test('账本写盘失败时抛错，不谎报成功', () => {
	const blocker = join(tmpdir(), 'dsh-ledger-blocker-' + process.pid + '.txt')
	writeFileSync(blocker, 'x')
	const previous = process.env.DSH_HOME
	process.env.DSH_HOME = blocker
	try {
		const entries = [{ task_id: 't', title: 'T', status: 'in_progress', text: 'x', seq: 1, ts: 1, window: 1, request_ref: 0 }]
		assert.throws(() => __test.writeLedger({ id: 'session-blocked' }, entries), /账本写入失败/)
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previous
		rmSync(blocker, { force: true })
	}
})

/** 最小 ctx：只提供 on / inject，够 registerNewContextTool 用。 */
function fakeCtx() {
	const handlers = new Map()
	const registered = []
	return {
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler])
		},
		inject(_services, callback) {
			callback({ tools: { register: (tool) => registered.push(tool) } })
		},
		handlers,
		registered
	}
}

test('下游已经压过窗时，new_context 不再压第二次', async () => {
	const { events, session } = snapshotSession()
	const ctx = fakeCtx()
	let calls = 0
	__test.registerNewContextTool(ctx, { compactRegion: async () => { calls += 1 } })
	const tool = ctx.registered.find((item) => item.name === 'new_context')
	const preStep = ctx.handlers.get('agent/pre-step')[0]

	await tool.execute({}, { agent: { session } })
	await preStep({ agent: { session } }, async () => ({ kind: 'continue' }))
	assert.equal(calls, 1, '下游没压过时正常消费一次')

	await tool.execute({}, { agent: { session } })
	await preStep({ agent: { session } }, async () => {
		const seq = session.seq + 1
		events.push({ type: 'compaction/end', seq, data: {}, time: 9999 })
		session.seq = seq
		return { kind: 'continue' }
	})
	assert.equal(calls, 1, '下游刚压过，就不能再压一遍')
})

test('账本多行记录渲染时续行缩进，不顶平任务层级', () => {
	const entry = stampEntry(
		{ task_id: 't1', title: 'T', status: 'in_progress', text: '首行要点\n已由系统归档：\n- 动作一', next_step: '接着做' },
		{ seq: 1, ts: 100, window: 2 }
	)
	const home = renderHome({ window: 2, entries: [entry], requests: [] }, { maxTokens: 8000, estimateTokens: __test.estimateTokens })
	const lines = home.split('\n')
	const at = lines.findIndex((line) => line.includes('首行要点'))
	assert.ok(at >= 0, '最新记录必须出现')
	assert.ok(lines[at].startsWith('  - 最新'), '首行跟着字段前缀走')
	for (const line of lines.slice(at + 1, at + 3)) {
		assert.ok(line.startsWith('    '), '续行必须缩进，否则读起来像另一条任务：' + JSON.stringify(line))
	}
})

test('脚本里的 stdout.write 与夹具路径不算写文件', () => {
	assert.deepEqual(__test.filePathsOf('process.stdout.write(x)\nconst fixture = {"file_path":"src/fetch.js"}'), [])
	assert.deepEqual(__test.filePathsOf('await tools.write({ file_path: "src/b.js", content: "y" })'), ['src/b.js'])
	assert.deepEqual(__test.filePathsOf('*** Update File: lib/a.js'), ['lib/a.js'], 'apply_patch 的路径写在补丁正文里')
})

test('交接信息先给最新请求与上一轮回复，起点压在它们之后', () => {
	const { session } = buildSession()
	const handoff = __test.assembleHandoff(session, options)
	const at = (marker) => handoff.indexOf(marker)
	assert.ok(at('## 最新请求（原话）') >= 0, '最新请求单独成段')
	assert.ok(at('## 最新请求（原话）') < at('## 上一次助手的最后回复'), '最新请求排在回复之前')
	assert.ok(at('## 上一次助手的最后回复') < at('## 任务起点'), '起点不能比它们先')
	assert.ok(at('## 任务起点') < at('继续之前先确认三件事'), '收尾指令仍在最末')
	assert.equal(handoff.split('接着做').length - 1, 1, '最新请求不重复占轨迹')
})
