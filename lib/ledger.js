/**
 * 任务账本：模型的阶段记录，以及渲染成的主页。
 *
 * 纯逻辑：行号、时间、窗口号由调用方注入，不碰磁盘、时钟与引擎。IO 在 `lib/index.js`。
 *
 * 证据编号直接用 dsh 会话事件的 `seq`。
 */

/** 任务状态。`superseded` 是"被别的任务取代"，`blocked` 是"卡住了等着"。 */
export const STATUSES = ['in_progress', 'done', 'superseded', 'blocked']

const STATUS_LABEL = {
	in_progress: '进行中',
	done: '已完成',
	superseded: '已被取代',
	blocked: '受阻'
}

/** task_id 的形状：短、稳定、模型自己起名。 */
const TASK_ID = /^[\w.-]{1,64}$/
const MAX_TITLE_CHARS = 200
const MAX_ANCHORS = 8
const MAX_MATCH_CHARS = 300
/** 单条 text 的上限：一句话的要点，不是流水账。 */
const DEFAULT_MAX_TEXT_CHARS = 1500

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const asText = (value) => (typeof value === 'string' ? value : '')
const asInt = (value) => (typeof value === 'number' && Number.isInteger(value) ? value : undefined)

/** 展示一个坏值而不在它身上抛错（对象的 toString 可能是垃圾）。 */
function describe(value) {
	try {
		if (typeof value === 'string') return value
		const text = JSON.stringify(value)
		return text === undefined ? typeof value : text
	} catch {
		return `（${typeof value}）`
	}
}

/**
 * 校验一条 `ledger_append` 输入，返回全部问题（中文，一句一条）。
 *
 * 输入类型未知，每个字段都在这里重新定型之后才被信任。
 *
 * @param input - 模型发来的原始输入（类型未知）。
 * @param context - 校验要用的现成事实：现有条目、按 seq 查事件、锚点检查、配置。
 * @returns 问题列表；空数组表示通过。
 */
export function validateAppend(input, context) {
	if (!isRecord(input)) {
		return ['ledger_append 的输入必须是一个对象，至少包含 task_id、title、status、text 四个字段。']
	}
	const problems = []
	const maxText = context.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS

	const taskId = input.task_id
	if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
		problems.push('task_id 只能由字母、数字、下划线、点和短横线组成，长度 1-64 个字符，请改成一个这样的短标识。')
	}

	const title = asText(input.title).trim()
	if (title === '') {
		problems.push('title 不能为空，请用一句话说明这个任务要做什么。')
	} else if (title.length > MAX_TITLE_CHARS) {
		problems.push(`title 有 ${title.length} 个字符，最多 ${MAX_TITLE_CHARS} 个，请压缩。`)
	}

	const status = input.status
	if (!STATUSES.includes(status)) {
		problems.push(`status 只能是 in_progress、done、superseded、blocked 之一，收到的是「${describe(input.status)}」。`)
	}

	if (input.text === undefined || typeof input.text !== 'string') {
		problems.push('text 必须是字符串，请用一句话说明这一步的要点。')
	} else if (input.text.trim() === '') {
		// 空条目会记成"有进展"却不含任何东西。
		problems.push('text 不能为空，请用一句话说明这一步的要点。')
	} else if (input.text.length > maxText) {
		problems.push(`text 有 ${input.text.length} 个字符，超过上限 ${maxText}，请拆成多条 ledger_append，这一条只留当前这一步的要点。`)
	}

	if (input.next_step !== undefined && typeof input.next_step !== 'string') {
		problems.push('next_step 必须是字符串，请用一句话写下一步做什么；不需要就整个省略。')
	}

	if (status === 'in_progress') {
		const given = input.next_step
		// 省略的 next_step 会从该任务的上一条继承，所以那也算"给了"。
		const earlier = tasksOf(context.entries).find((task) => task.taskId === taskId)?.nextStep?.value
		const hasStep = typeof given === 'string' ? given.trim() !== '' : given === undefined && (earlier ?? '').trim() !== ''
		if (!hasStep && (given === undefined || typeof given === 'string')) {
			problems.push('status 是 in_progress，必须写 next_step：换窗口后要接着做的下一步。任务做完了就标 done。')
		}
	}

	if (input.superseded_by !== undefined && typeof input.superseded_by !== 'string') {
		problems.push('superseded_by 必须是字符串：取代它的那个 task_id。')
	}

	// request_ref 指向"这条记录回应的是哪次用户请求"。省略不报错——会话可能还没有人说过话，
	// 那段也该能记账（存成 0）。
	if (input.request_ref !== undefined) {
		const refSeq = asInt(input.request_ref)
		if (refSeq === undefined) {
			problems.push('request_ref 必须是历史编号（有限整数）。')
		} else if (context.eventAt(refSeq) === undefined) {
			problems.push(`request_ref #${refSeq} 在会话里不存在，请用 history 查一个真实的历史编号。`)
		} else if (!context.isUserMessage(refSeq)) {
			problems.push(`request_ref #${refSeq} 不是用户消息，请指向用户亲口提的那条消息；没有就省略 request_ref。`)
		}
	}

	const evidenceGiven = input.evidence !== undefined
	const evidence = Array.isArray(input.evidence) ? input.evidence : []
	if (evidenceGiven && !Array.isArray(input.evidence)) {
		problems.push('evidence 必须是历史编号的数组，例如 [12, 15]，请把非编号的内容去掉。')
	} else {
		const junk = evidence.filter((item) => asInt(item) === undefined)
		if (junk.length > 0) {
			problems.push(`evidence 里只能放历史编号（有限整数），有 ${junk.length} 项不是，请把它们去掉。`)
		}
	}

	if (status === 'done') {
		const seqs = evidence.filter((item) => asInt(item) !== undefined)
		if (seqs.length === 0) {
			problems.push('status 是 done，必须给出 evidence：至少一个能证明做完的历史编号。')
		}
		for (const seq of seqs) {
			const event = context.eventAt(seq)
			if (event === undefined) {
				problems.push(`evidence #${seq} 在会话里不存在，请换成真实的历史编号。`)
				continue
			}
			if (event.type !== 'tool/result') {
				problems.push(`evidence #${seq} 是 ${event.type}，不是工具结果；完成的证据要是工具结果。`)
				continue
			}
			if (event.data?.message?.isError === true) {
				problems.push(`evidence #${seq} 是一次报错的工具结果，不能当作完成的证据，请换成成功的工具结果。`)
			}
		}
	}

	if (status === 'superseded') {
		const by = asText(input.superseded_by).trim()
		if (by === '') {
			if (typeof input.superseded_by === 'string' || input.superseded_by === undefined) {
				problems.push('status 是 superseded，必须写 superseded_by：取代它的那个 task_id。')
			}
		} else if (by === taskId) {
			problems.push('superseded_by 不能是任务自己，请写真正取代它的另一个 task_id。')
		}
	}

	const rawAnchors = input.anchors
	if (rawAnchors !== undefined && !Array.isArray(rawAnchors)) {
		problems.push('anchors 必须是数组，每项是一个含 path、match、note 三个字符串字段的对象。')
	} else {
		const anchors = Array.isArray(rawAnchors) ? rawAnchors : []
		if (anchors.length > MAX_ANCHORS) {
			problems.push(`anchors 最多 ${MAX_ANCHORS} 个，收到 ${anchors.length} 个，请删掉不重要的。`)
		}
		anchors.forEach((anchor, index) => {
			const at = index + 1
			if (!isRecord(anchor)) {
				problems.push(`锚点 ${at} 必须是对象，含 path、match、note 三个字符串字段，请改写。`)
				return
			}
			const wrong = []
			if (typeof anchor.path !== 'string') wrong.push('path')
			if (typeof anchor.match !== 'string') wrong.push('match')
			if (anchor.note !== undefined && typeof anchor.note !== 'string') wrong.push('note')
			if (wrong.length > 0) {
				problems.push(`锚点 ${at} 的 ${wrong.join('、')} 必须是字符串（note 可以省略），请改正。`)
			}

			const path = asText(anchor.path).trim()
			const match = asText(anchor.match).trim()
			if (typeof anchor.path === 'string' && path === '') {
				problems.push(`锚点 ${at} 的 path 不能为空，请给出文件路径。`)
			}
			if (typeof anchor.match === 'string') {
				if (match === '') {
					problems.push(`锚点 ${at} 的 match 不能为空，请给一段在文件里能找到的原文。`)
				} else if (match.length > MAX_MATCH_CHARS) {
					problems.push(`锚点 ${at} 的 match 有 ${match.length} 个字符，最多 ${MAX_MATCH_CHARS} 个，请截短。`)
				}
			}
			if (path === '' || match === '') return

			// 锚点必须能在文件里唯一找到，否则该锚点作废。
			const check = context.checkAnchor({ path, match, note: asText(anchor.note) })
			if (check === 'missing-file') {
				problems.push(`锚点 ${at} 的文件不存在：${path}，请确认路径，或先用工具读一下再写。`)
			} else if (check === 'no-match') {
				problems.push(`锚点 ${at} 在 ${path} 里找不到 match 这段原文，请换一段确实存在于文件里的原文。`)
			} else if (check === 'ambiguous') {
				problems.push(`锚点 ${at} 的 match 在 ${path} 里出现多次，请换一段能唯一定位的原文。`)
			}
		})
	}

	return problems
}

/** 保留锚点的三个字符串字段，别的都不要。 */
function anchorOf(value) {
	if (!isRecord(value)) return undefined
	return { path: asText(value.path), match: asText(value.match), note: asText(value.note) }
}

function anchorsOf(value) {
	if (!Array.isArray(value)) return undefined
	const anchors = []
	for (const item of value) {
		const anchor = anchorOf(item)
		if (anchor !== undefined) anchors.push(anchor)
	}
	return anchors
}

function intsOf(value) {
	if (!Array.isArray(value)) return undefined
	const ints = []
	for (const item of value) {
		const int = asInt(item)
		if (int !== undefined) ints.push(int)
	}
	return ints
}

/**
 * 把校验过的输入变成落盘的那条记录：seq、时间、窗口号由调用方给。
 * 只写入类型正确的字段。
 */
export function stampEntry(input, meta) {
	const raw = isRecord(input) ? input : {}
	const entry = {
		task_id: asText(raw.task_id),
		title: asText(raw.title),
		status: STATUSES.includes(raw.status) ? raw.status : 'in_progress',
		text: asText(raw.text),
		seq: meta.seq,
		ts: meta.ts,
		window: meta.window,
		request_ref: asInt(raw.request_ref) ?? meta.defaultRequestSeq ?? 0
	}
	if (typeof raw.next_step === 'string') entry.next_step = raw.next_step
	const anchors = anchorsOf(raw.anchors)
	if (anchors !== undefined) entry.anchors = anchors
	const evidence = intsOf(raw.evidence)
	if (evidence !== undefined) entry.evidence = evidence
	if (typeof raw.superseded_by === 'string') entry.superseded_by = raw.superseded_by
	// 让后面的检查知道这条记录覆盖到了哪个历史编号。
	if (meta.through !== undefined) entry.through = meta.through
	return entry
}

const isClosedStatus = (status) => status === 'done' || status === 'superseded'

/**
 * 从最新一条给了值的记录继承字段：省略表示不变，空值表示清空并终止回溯。
 */
function resolveField(entries, pick, isEmpty) {
	const last = entries[entries.length - 1]
	if (last === undefined || isClosedStatus(last.status)) return undefined
	for (let at = entries.length - 1; at >= 0; at -= 1) {
		const entry = entries[at]
		if (entry === undefined || (at < entries.length - 1 && isClosedStatus(entry.status))) return undefined
		const value = pick(entry)
		if (value === undefined) continue
		return isEmpty(value) ? undefined : { value, seq: entry.seq, isInherited: at < entries.length - 1 }
	}
	return undefined
}

/** 按 task 归并条目；后面的条目成为最新的那条。 */
export function tasksOf(entries) {
	const byId = new Map()
	for (const entry of entries) {
		const found = byId.get(entry.task_id)
		if (found === undefined) {
			byId.set(entry.task_id, {
				taskId: entry.task_id,
				title: entry.title,
				status: entry.status,
				first: entry,
				latest: entry,
				entries: [entry]
			})
			continue
		}
		found.entries.push(entry)
		found.title = entry.title
		found.status = entry.status
		found.latest = entry
	}

	const tasks = [...byId.values()]
	for (const task of tasks) {
		const nextStep = resolveField(
			task.entries,
			(entry) => (typeof entry.next_step === 'string' ? entry.next_step : undefined),
			(value) => value.trim() === ''
		)
		if (nextStep !== undefined) task.nextStep = nextStep
		const anchors = resolveField(
			task.entries,
			(entry) => (Array.isArray(entry.anchors) ? entry.anchors : undefined),
			(value) => value.length === 0
		)
		if (anchors !== undefined) task.anchors = anchors
	}
	return tasks
}

/** 本窗口在最新一条用户请求之后有没有记过账。这是换窗门槛的第一道。 */
export function hasFreshEntry(entries, sinceTs, window) {
	return entries.some((entry) => entry.window === window && entry.ts >= sinceTs)
}

/**
 * 最新一条账本记录之后、没被它覆盖到的工具结果。这是换窗门槛的第二道。
 *
 * 覆盖判断优先用 `through`（记账那一刻的历史编号）；更早的条目没有它，退回按时间比。
 * `sinceSeq` 是本窗口的起点，即最后一次换窗的编号。
 *
 * @param entries - 账本条目。
 * @param events - `{ type, seq, ts }` 形状的事件列表。
 * @param window - 当前窗口号（用来挑出该窗口的账本条目）。
 * @param sinceSeq - 本窗口的起始编号，缺省为 0（第一个窗口）。
 */
export function tailOf(entries, events, window, sinceSeq = 0) {
	let latest
	for (const entry of entries) {
		if (entry.window === window && (latest === undefined || entry.seq > latest.seq)) latest = entry
	}
	let steps = 0
	let from
	let to
	for (const event of events) {
		if (event.type !== 'tool/result' || event.seq <= sinceSeq) continue
		if (latest !== undefined) {
			const isCovered = typeof latest.through === 'number' ? event.seq <= latest.through : event.ts <= latest.ts
			if (isCovered) continue
		}
		steps += 1
		if (from === undefined || event.seq < from) from = event.seq
		if (to === undefined || event.seq > to) to = event.seq
	}
	return { steps, from, to, entrySeq: latest === undefined ? undefined : latest.seq }
}

const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}……` : text)

/** 一条条目的单行形式，`ledger_read` 的明细视图用。 */
export function renderEntry(entry) {
	const parts = [`#L${entry.seq}`, entry.task_id, STATUS_LABEL[entry.status] ?? entry.status, entry.title, entry.text]
	if (typeof entry.next_step === 'string' && entry.next_step.trim() !== '') parts.push(`下一步：${entry.next_step}`)
	if (Array.isArray(entry.evidence) && entry.evidence.length > 0) {
		parts.push(`证据：${entry.evidence.map((seq) => `#${seq}`).join('、')}`)
	}
	if (typeof entry.superseded_by === 'string' && entry.superseded_by !== '') parts.push(`由 ${entry.superseded_by} 取代`)
	if (Array.isArray(entry.anchors) && entry.anchors.length > 0) {
		parts.push(`锚点：${entry.anchors.map((anchor) => `${anchor.path}（${anchor.note || anchor.match.slice(0, 40)}）`).join('；')}`)
	}
	return parts.join(' · ')
}

export function renderEntries(entries) {
	return entries.length === 0 ? '账本里还没有条目。' : entries.map(renderEntry).join('\n')
}

/** 未完成的任务排在前面，同状态内新的在前。 */
function newestFirst(tasks) {
	return [...tasks].sort((left, right) => right.latest.ts - left.latest.ts || right.latest.seq - left.latest.seq)
}

/**
 * 笔记段的字数预算。**不设条数上限**：最旧的那条常常是最关键的（数据源定稿、硬约束、
 * 踩过的坑），而前一次换窗已经把对话正文遮掉了 —— 按条数从旧的开始砍，丢掉的东西
 * 就再也找不回来。预算按字数算，从最新往回取，最新一条无论多长都留下。
 */
const WINDOW_NOTES_CHARS = 6000

/**
 * 一个任务留下的笔记，旧→新。从最新往回取，直到条数或字数预算用完；最新一条总是保留。
 */
function windowNotesOf(task, entries) {
	const newest = entries
		.filter((entry) => entry.task_id === task.latest.task_id)
		.sort((left, right) => right.window - left.window || right.seq - left.seq)
	const picked = []
	let chars = 0
	for (const entry of newest) {
		// 最新一条无论如何都留：新窗口靠它知道现在做到哪一步。
		if (picked.length > 0 && chars + entry.text.length > WINDOW_NOTES_CHARS) break
		picked.push(entry)
		chars += entry.text.length
	}
	return picked.reverse()
}

/** 主页最多完整显示几个未完成任务，其余的只给摘要。 */
const MAX_FULL_ACTIVE = 5
const SHORT_FIELD_CHARS = 200

/**
 * 新窗口打开时读的那一页：用户的原话在前，然后是还没做完的事。超预算时从最旧的内容开始丢。
 */
export function renderHome(input, options = {}) {
	const maxTokens = options.maxTokens ?? 4000
	const estimate = options.estimateTokens ?? (() => 0)
	const tasks = tasksOf(input.entries)
	const active = tasks.filter((task) => task.status === 'in_progress' || task.status === 'blocked')
	const doneLines = newestFirst(tasks.filter((task) => task.status === 'done')).map((task) => `- ${task.title}`)
	const superLines = newestFirst(tasks.filter((task) => task.status === 'superseded')).map(
		(task) => `- ${task.title}${task.latest.superseded_by ? `（已由 ${task.latest.superseded_by} 取代）` : ''}`
	)

	const head = []
	head.push(input.window === 1 ? '当前是第 1 个窗口。' : `当前是第 ${input.window} 个窗口（上一个是第 ${input.window - 1} 个）。`)
	head.push('', '## 最近的用户请求（原话）')
	if (input.requests.length === 0) head.push('无')
	for (const record of input.requests) head.push(`- \`#${record.seq}\` ${clip(record.text, 400)}`)

	head.push('', '## 进行中 / 受阻的任务')
	if (active.length === 0) {
		head.push('无')
	} else {
		const ordered = newestFirst(active)
		const full = ordered.slice(0, MAX_FULL_ACTIVE)
		const short = ordered.slice(MAX_FULL_ACTIVE)
		for (const task of full) {
			head.push(`- **${task.taskId}**：${task.title}（${STATUS_LABEL[task.status] ?? task.status}）`)
			const notes = windowNotesOf(task, input.entries)
			if (notes.length <= 1) {
				// 覆盖点（through）是新窗口对齐时间线的关键：它说明这条记录
				// 看到了哪个历史编号为止，比它新的事件以交接信息的动作段为准。
				const through = typeof task.latest.through === 'number' ? `（账本覆盖到 \`#${task.latest.through}\`，更早于它的动作见交接信息）` : ''
				head.push(`  - 最新：${task.latest.text}${through}`)
			} else {
				head.push('  - 记录（旧→新）：')
				for (const note of notes) {
					const through = typeof note.through === 'number' ? `（覆盖到 \`#${note.through}\`）` : ''
					head.push(`    - \`#L${note.seq}\`${through}：${note.text}`)
				}
			}
			if (task.nextStep !== undefined) {
				head.push(
					task.nextStep.isInherited
						? `  - 下一步（沿用 \`#L${task.nextStep.seq}\` 的记录，可能已过时）：${task.nextStep.value}`
						: `  - 下一步：${task.nextStep.value}`
				)
			}
			if (task.anchors !== undefined && task.anchors.value.length > 0) {
				head.push('  - 待改位置：')
				for (const anchor of task.anchors.value) {
					head.push(`    - ${anchor.path} · ${anchor.note || anchor.match.slice(0, 60)}`)
				}
			}
		}
		for (const task of short) {
			head.push(`- **${task.taskId}**：${task.title}（${STATUS_LABEL[task.status] ?? task.status}）`)
			const through = typeof task.latest.through === 'number' ? `（覆盖到 \`#${task.latest.through}\`）` : ''
			head.push(`  - 最新 \`#L${task.latest.seq}\`${through}：${clip(task.latest.text, SHORT_FIELD_CHARS)}`)
			if (task.nextStep !== undefined) head.push(`  - 下一步：${clip(task.nextStep.value, SHORT_FIELD_CHARS)}`)
		}
		if (short.length > 0) {
			head.push(`（还有 ${short.length} 个较早更新的任务只显示了摘要，完整记录用 ledger_read 查）`)
		}
	}

	let trimmed = 0
	const build = () => {
		const lines = [...head]
		if (superLines.length > 0) lines.push('', '## 不要继续这些（已被取代）', ...superLines)
		if (doneLines.length > 0) lines.push('', '## 已完成', ...doneLines)
		if (trimmed > 0) lines.push('', `（已省略 ${trimmed} 条较早的记录）`)
		return lines.join('\n')
	}

	let text = build()
	// 前几段（请求、未完成任务）不参与裁剪：它们不是"可选内容"。
	while (estimate(text) > maxTokens && doneLines.length + superLines.length > 0) {
		if (superLines.length > 0) superLines.pop()
		else doneLines.pop()
		trimmed += 1
		text = build()
	}
	return text
}

/**
 * 由代码在换窗前落一条自动快照，把未记账的进度钉进账本。
 *
 * 背景：`new_context` 有两道账本门槛，但自动压力换窗没有——触发时模型正在干活、
 * 没机会记账，换窗后账本停留在很久以前，新窗口照过时记录重做已完成的步骤。
 * 这条快照把「最近一段未记账动作」归档成一条 in_progress 记录，`through` 盖到
 * 当前历史编号，让门槛 2（tailOf）在后续检查里必然通过。
 *
 * 纯逻辑：读什么、写什么由调用方决定；这里只组文本。
 *
 * @param entries - 现有账本条目（调用方刚读过）。
 * @param unlogged - 未记账的工具结果摘要（旧→新），每项 `{ seq, ts, brief }`。
 * @param meta - `{ seq, ts, window, through, requestRef }`。
 * @returns 新的条目数组与追加的那条（没有未记账动作时返回原数组与 undefined）。
 */
export function appendAutoSnapshot(entries, unlogged, meta) {
	if (unlogged.length === 0) return { entries, appended: undefined }
	const lines = unlogged.slice(-6).map((step) => `\`#${step.seq}\` ${step.brief}`)
	const text = [
		`换窗前自动快照：最近 ${unlogged.length} 个工具结果未记账（未记账的动作从 \`#${unlogged[0].seq}\` 到 \`#${unlogged[unlogged.length - 1].seq}\`），`
			+ '其完成状态以交接信息的「最近的动作」段与 history 回查为准，不要凭账本重做这一段。',
		'已由系统归档：',
		...lines.map((line) => `- ${line}`)
	].join('\n')
	const entry = {
		task_id: 'auto-snapshot',
		title: `换窗前自动快照（第 ${meta.window} 窗口）`,
		status: 'in_progress',
		text,
		seq: meta.seq,
		ts: meta.ts,
		window: meta.window,
		request_ref: meta.requestRef ?? 0,
		through: meta.through,
		// 告诉 renderHome 的窗口计数：这是代码写的，不是模型记的账。
		kind: 'auto'
	}
	return { entries: [...entries, entry], appended: entry }
}
