/**
 * dsh-compact-codex 的浏览器半侧。
 *
 * 把本插件产出的压缩交接消息渲染成一张卡片，替换引擎默认的压缩行样式。
 *
 * 接法：
 *   1. `ctx.uiConversation.events.register()` 注册事件定义，`match` 认内容以
 *      `# 上下文交接` 开头的 user 消息；
 *   2. 把视图注册进 `conversation.chat.node` 这个 keyed slot，key 是 `buildViewNode()`
 *      产出的 `kind`，即 renderer key。
 *
 * 两条约束：
 *   - 除 React 基座外不 require 任何 `dsh-client-*` 包。抛错的组件会清空整个 slot 条目。
 *     控件与 Markdown 渲染都在本模块内实现，配色只用 `--dsw-alias-*` 主题 token。
 *   - factory 内不产生副作用；样式注入放在 `apply` 内，由 `ctx.effect` 管理生命周期。
 *
 * 产物是惰性 CJS factory：执行它只注册 factory，模块主体到物化时才跑。
 */

window.__ModuleLoader__.load({
	id: 'dsh-compact-codex',
	factory(require) {
		// 与已在用的第三方插件（dsh-purge、tavernweave-workbench）用同一骨架：
		// module/exports 包装、打 Module 标记、最后 return module.exports。
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement

		/**
		 * 交接消息的识别标记：基类 `frameSummary` 把摘要包成
		 * `preamble + <compacted-summary> + 摘要 + </compacted-summary>`，
		 * 拿这个标签判断消息是不是压缩检查点（不能锚定行首，文本以 preamble 开头）。
		 */
		const HANDOFF_MARK = /<compacted-summary>/
		/** 基类包裹摘要用的标签，渲染前要剥掉。 */
		const SUMMARY_OPEN = '<compacted-summary>'
		const SUMMARY_CLOSE = '</compacted-summary>'
		/** renderer key：既是事件定义的 kind，也是 slot 注册的 key。 */
		const NODE_KIND = 'compact-codex-handoff'

		const CSS = [
			'.ccc_row{border-left:2px solid var(--dsw-alias-state-business-primary);',
			'background:color-mix(in srgb,var(--dsw-alias-bg-base) 88%,var(--dsw-alias-state-business-primary) 12%);',
			'border-radius:var(--dsw-radius-sm);padding:6px 10px;margin:2px 0}',
			'.ccc_head{align-items:center;gap:6px;cursor:pointer;user-select:none;list-style:none;',
			'font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(22px + var(--dsh-content-font-delta-secondary,0px));',
			'color:var(--dsw-alias-label-tertiary);display:flex}',
			'.ccc_head::-webkit-details-marker{display:none}',
			'.ccc_head:hover{color:var(--dsw-alias-label-secondary)}',
			'.ccc_dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}',
			'.ccc_label{font-weight:600;color:var(--dsw-alias-label-primary);flex:none}',
			'.ccc_meta{color:inherit;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:auto}',
			'.ccc_body{margin:6px 0 0;padding:8px 0 0;border-top:1px solid var(--dsw-alias-border-l1);',
			'color:var(--dsw-alias-label-secondary);word-break:break-word;',
			'font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
			'.ccc_h1{font-weight:600;color:var(--dsw-alias-label-primary);font-size:calc(var(--dsh-content-font-size-secondary,13px) + 2px);margin:0 0 4px}',
			'.ccc_h2{font-weight:600;color:var(--dsw-alias-label-primary);margin:10px 0 2px}',
			'.ccc_p{margin:0}',
			'.ccc_gap{height:6px}',
			'.ccc_quote{border-left:2px solid color-mix(in srgb,var(--dsw-alias-label-tertiary) 55%,transparent);padding-left:8px;color:var(--dsw-alias-label-tertiary);margin:1px 0}',
			'.ccc_li{padding-left:14px;text-indent:-14px;margin:0}',
			'.ccc_code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
			'color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-bg-base) 80%,#000 20%);border-radius:3px;padding:0 3px}',
			'.ccc_hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0}',
			// 同一次压缩在界面上只能出现一次。官方 dsh-client-ui-chat 会另渲染一条
			// marker 行（"上下文已压缩 · 已压缩 N 条历史记录"），它读的是压缩节点自身的
			// shadowedItemCount，与本卡片是两套独立渲染——合并不了数据，就按 CSS Modules
			// 的类名子串把它收掉，由卡片独占这段历史的展示。
			//
			// 类名形如 `cJsG2q_compactionRow`，前缀是构建期哈希，只有后缀稳定；
			// 用子串选择器（本插件自己的类名都是 `ccc_` 前缀，不会误伤）。
			'[class*="compactionRow"]{display:none!important}'
		].join('')

		/** 从消息内容块里取出纯文本。 */
		function textOf(content) {
			if (!Array.isArray(content)) return ''
			const parts = []
			for (const block of content) {
				if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text)
			}
			return parts.join('\n')
		}

		/**
		 * 行内渲染：把 `代码` 与 **粗体** 变成元素，其余保持文本。
		 */
		function inline(text, keyBase) {
			const parts = []
			const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g
			let cursor = 0
			let index = 0
			let match = pattern.exec(text)
			while (match !== null) {
				if (match.index > cursor) parts.push(text.slice(cursor, match.index))
				const token = match[0]
				if (token.charCodeAt(0) === 96) parts.push(h('code', { key: `${keyBase}-c${index}`, className: 'ccc_code' }, token.slice(1, -1)))
				else parts.push(h('strong', { key: `${keyBase}-b${index}` }, token.slice(2, -2)))
				index += 1
				cursor = match.index + token.length
				match = pattern.exec(text)
			}
			if (cursor < text.length) parts.push(text.slice(cursor))
			return parts.length === 0 ? '' : parts
		}

		/** 行级渲染：标题、引用、列表、分隔线各归各的样式。 */
		function body(text) {
			return text.split('\n').map((line, index) => {
				const key = `l${index}`
				if (line.startsWith('# ')) return h('div', { key, className: 'ccc_h1' }, inline(line.slice(2), key))
				if (line.startsWith('## ')) return h('div', { key, className: 'ccc_h2' }, inline(line.slice(3), key))
				if (line.startsWith('> ')) return h('div', { key, className: 'ccc_quote' }, inline(line.slice(2), key))
				if (line.startsWith('- ')) return h('div', { key, className: 'ccc_li' }, ['· ', ...inline(line.slice(2), key)])
				if (line.trim() === '---') return h('hr', { key, className: 'ccc_hr' })
				if (line.trim() === '') return h('div', { key, className: 'ccc_gap' })
				return h('div', { key, className: 'ccc_p' }, inline(line, key))
			})
		}

		/**
		 * 从检查点消息里剥出交接信息本体：去掉基类的 preamble 与
		 * `<compacted-summary>` 包裹，只留要渲染的那部分。
		 */
		function handoffBody(raw) {
			const open = raw.indexOf(SUMMARY_OPEN)
			if (open === -1) return raw.trim()
			const from = open + SUMMARY_OPEN.length
			const close = raw.lastIndexOf(SUMMARY_CLOSE)
			return (close === -1 ? raw.slice(from) : raw.slice(from, close)).trim()
		}

		/** 交接卡片的渲染。数据来自 `buildViewNode().data`，组件无状态。 */
		const HandoffView = React.memo(function HandoffView({ node }) {
			const text = node?.data?.text ?? ''
			const summary = node?.data?.summary ?? ''
			return h('details', { className: 'ccc_row' }, [
				h('summary', { className: 'ccc_head', key: 'head' }, [
					h('span', { className: 'ccc_dot', key: 'dot', 'aria-hidden': true }),
					h('span', { className: 'ccc_label', key: 'label' }, '上下文交接'),
					h('span', { className: 'ccc_meta', key: 'meta' }, summary)
				]),
				h('div', { className: 'ccc_body', key: 'body' }, body(text))
			])
		})

		/** 摘出折叠行右侧要显示的一句话：交接信息里「最近的用户请求」的第一条。 */
		function firstRequestLine(text) {
			const lines = text.split('\n')
			// 两种编号写法都要认：`#123`（行内代码）与 [#123]；编号前可能带列表符号
			// 或空白，所以这里放宽到"行首符号 + 编号"，并把符号剥掉再显示。
			const at = lines.findIndex((line) => /^\s*[-·*]\s*(?:`#\d+`|\[#\d+\])/.test(line))
			if (at !== -1) return lines[at].replace(/^\s*[-·*]\s*/, '')
			// 退路要跳过标题与引用：开场白是 `> …`，落回它会让折叠行显示一句泛泛的
			// 说明，而不是这一条交接到底讲了什么。
			const head = lines.find((line) => {
				const trimmed = line.trim()
				return trimmed !== '' && !trimmed.startsWith('#') && !trimmed.startsWith('>')
			})
			return head ?? ''
		}

		/** 交接消息的事件定义；`match` 是唯一把它和普通 user 消息区分开的地方。 */
		const handoffDefinition = {
			kind: NODE_KIND,
			target: 'chat',
			match: (event) => {
				if (event.type !== 'user/message') return null
				if (!HANDOFF_MARK.test(textOf(event.data?.content))) return null
				return { id: String(event.seq), role: 'start' }
			},
			start: (_context, match) => ({
				seq: match.event.seq,
				text: handoffBody(textOf(match.event.data?.content))
			}),
			update: (context) => context.state,
			buildViewNode: (context) => {
				if (context.state === undefined) return null
				const text = context.state.text ?? ''
				return {
					key: context.key,
					kind: NODE_KIND,
					id: context.id,
					target: 'chat',
					anchorSeq: context.state.seq - 0.1,
					location: context.start?.location ?? { kind: 'unresolved' },
					visibility: 'visible',
					data: { text, summary: firstRequestLine(text) }
				}
			}
		}

		// Cordis 服务依赖。`uiConversation` 必须在这里声明——apply 里会用
		// `ctx.uiConversation.events.register(...)`，没声明的话它是 undefined，
		// apply 一抛错 fiber 就变成 failed，启动期报 `entry did not activate`。
		// 官方的 dsh-client-ui-goal 同样是靠 inject 拿到它的（见其 client.js 的
		// ["slots","sessions","remote","remote.goals","locale","uiConversation"]）。
		const inject = ['slots', 'uiConversation']

		/** 插件激活：注入样式，注册事件定义与 renderer。 */
		function apply(ctx) {
			// 样式随插件生命周期注入与移除，不让它留在 document.head 里。
			ctx.effect(() => {
				if (typeof document === 'undefined') return () => {}
				const tagId = 'dsh-compact-codex/handoff.css'
				if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return () => {}
				const tag = document.createElement('style')
				tag.dataset.plugin = 'dsh-compact-codex'
				tag.dataset.pluginCss = tagId
				tag.textContent = CSS
				document.head.appendChild(tag)
				return () => tag.remove()
			})
			ctx.uiConversation.events.register(handoffDefinition)
			ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
				name: 'conversation.chat.node',
				key: NODE_KIND
			}, HandoffView))
		}

		exports.name = 'dsh-compact-codex'
		exports.inject = inject
		exports.apply = apply
		return module.exports
	}
})
