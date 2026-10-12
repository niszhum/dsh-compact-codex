/**
 * 从官方 bundle 的 preset 声明生成本包的 cordis.patch.yml。
 *
 * 为什么要生成而不是手写：preset 声明是 `@deepseek-ai/dsh-agent-preset` 插件的完整
 * `config.plugins` 列表，而 loader 的 patch 语义是**整体替换目标行的 config**，
 * 无法按 id 命中列表内部的某一行。所以要改压缩后端，只能把整份列表原样搬过来、
 * 只动那一行。手抄会随 dsh 升级腐坏，故由本脚本负责重放。
 *
 * dsh 升级后重跑一次即可重新对齐：node ./sync-presets.mjs
 *
 * @module dsh-compact-codex/sync-presets
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 官方 preset 声明所在目录。
 *
 * 默认读本包 node_modules 里的 `dsh-web-app` 联接（安装步骤会建），因此脚本不依赖
 * dsh 装在哪。要在未建联接的环境里跑，用 `DSH_CHECKOUT` 指向 dsh 的 `resources/app/dsh`。
 */
const presetsDir = process.env.DSH_CHECKOUT !== undefined
	? join(process.env.DSH_CHECKOUT, 'node_modules/@deepseek-ai/dsh-web-app/presets')
	: join(here, 'node_modules/@deepseek-ai/dsh-web-app/presets')
if (!existsSync(presetsDir)) {
	throw new Error(`找不到官方 preset 声明：${presetsDir}\n请先按 README 建立 node_modules 联接，或用 DSH_CHECKOUT 指向 dsh 的 resources/app/dsh`)
}

/** 官方随带的四个 preset 声明；顺序沿用 dsh-web-app/package.json 的 dsh.bundle.patch。 */
const presetFiles = ['standard.patch.yml', 'ptc.patch.yml', 'minimal.patch.yml', 'cordis.patch.yml']

/** 被替换的压缩后端模块名。 */
const backendFrom = "'@deepseek-ai/dsh-compaction-basic'"
/** 替换成的模块名，即本包。 */
const backendTo = "'dsh-compact-codex'"

/**
 * 可选的配置注入。
 *
 * 要注入的键值写在同目录的 preset-config.json 里，例如
 * `{"style": "reset", "handoffTokens": 20000}`，每次生成都会带上。
 */
const configPath = join(here, 'preset-config.json')
const injected = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined

/**
 * 把注入配置挂到压缩后端那一行的 config 上，缩进与所在行对齐。
 * @param block - 反缩进后的 entry 列表文本。
 * @returns 注入后的文本；没有配置或找不到该行时原样返回。
 */
function injectConfig(block) {
	if (injected === undefined) return block
	const lines = block.split('\n')
	const at = lines.findIndex((line) => line.trimEnd().endsWith(`name: ${backendTo}`))
	if (at === -1) return block
	const indent = /^(\s*)/.exec(lines[at])[1]
	const rendered = [
		'config:',
		...Object.entries(injected).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
	].map((line, index) => `${indent}${index === 0 ? '' : '  '}${line}`)
	lines.splice(at + 1, 0, ...rendered)
	return lines.join('\n')
}

/**
 * 把 bundle patch 里 `- insert:` 之下的四空格缩进块反缩进成顶层 entry 列表。
 *
 * 统一减掉四空格对 YAML 语义是安全的：block scalar 的缩进是相对其 key 计算的，
 * key 与内容的相对关系不变，因此多行文本块（如 plan-mode 的 section）不受影响。
 * @param source - patch 文件全文。
 * @param file - 文件名，仅用于报错。
 * @returns 顶层化的 entry 列表文本。
 */
function liftInsertBlock(source, file) {
	const lines = source.split('\n')
	const start = lines.findIndex((line) => line === '- insert:')
	if (start === -1) throw new Error(`${file}: no top-level "- insert:" block`)
	const body = []
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index]
		if (line.trim() === '') {
			body.push('')
			continue
		}
		if (!line.startsWith(' ')) break
		if (!line.startsWith('    ')) throw new Error(`${file}: unexpected indentation at line ${index + 1}`)
		body.push(line.slice(4))
	}
	while (body.length > 0 && body[body.length - 1] === '') body.pop()
	return body.join('\n')
}

const sections = []
const report = []

for (const presetFile of presetFiles) {
	const source = readFileSync(join(presetsDir, presetFile), 'utf8')
	const lifted = liftInsertBlock(source, presetFile)
	if (!lifted.includes('@deepseek-ai/dsh-agent-preset')) throw new Error(`${presetFile}: lifted block declares no agent preset`)
	const swapped = lifted.includes(backendFrom)
	if (swapped) {
		// 该字符串在单个 preset 声明里只出现一次，即 compaction group 内的那一行。
		if (lifted.split(backendFrom).length !== 2) throw new Error(`${presetFile}: expected exactly one compaction backend row`)
	}
	const output = swapped ? injectConfig(lifted.replace(backendFrom, backendTo)) : lifted
	sections.push(`# --- ${presetFile} ---\n\n${output}`)
	report.push(`${presetFile}: ${swapped ? `replaced compaction backend${injected === undefined ? '' : ' + injected config'}` : 'no compaction group, kept as-is'}`)
}

const header = [
	'# dsh-compact-codex 的 bundle patch —— 由 sync-presets.mjs 生成，请勿手改。',
	'#',
	'# 每个 preset 声明行的 config 被完整重述，只把 compression group 里的',
	'# compaction-basic 换成 dsh-compact-codex。同组的 command-compact 与',
	'# tool-result-pruner 保持原样：前者只依赖抽象 seam，会自动跟随新后端；',
	'# 后者必须留在同一 isolate realm 内，基类要靠 ctx.get(\'toolResultPruner\') 读它。',
	'#',
	'# dsh 升级后重跑：node ./sync-presets.mjs',
	''
].join('\n')

/**
 * 宿主层载体行：让本包的 `dsh.client` 声明进入浏览器启动图。
 *
 * `dsh-client-modules` 只扫宿主树的 Loader 条目，而 preset 声明里的行是 preset realm
 * 的子插件、不是顶层条目。因此只替换 preset 层的压缩后端，服务端换对了后端，浏览器侧
 * 却扫不到本包：界面没有变化，也不会有报错。
 *
 * 代价是 `lib/client.js` 若在激活期抛错，浏览器启动会失败并输出
 * `web boot: N entry did not activate`。排查期间可以用环境变量跳过这一行，修好后再按
 * 默认值重新生成：
 *
 *     $env:DSH_COMPACT_CODEX_CARRIER = '0'; node ./sync-presets.mjs
 */
const hostSection = [
	'# --- 宿主层：客户端载体行（本包的 dsh.client 声明靠这一行被扫到）---',
	'',
	'- insert:',
	'    - id: compact-codex-client-anchor',
	`      name: ${backendTo}`
].join('\n')
const carrierOff = process.env.DSH_COMPACT_CODEX_CARRIER === '0'
if (!carrierOff) {
	sections.push(hostSection)
	report.push('主机层: inserted compact-codex-client-anchor')
}
const carrierNote = carrierOff
	? '【应急模式：已去掉载体行，客户端半侧不加载，桌面端必定可启动】'
	: '【正常模式：含载体行，客户端半侧生效】'

writeFileSync(join(here, 'cordis.patch.yml'), `${header}\n${sections.join('\n\n')}\n`, 'utf8')

for (const line of report) console.log(line)
console.log(carrierNote)
console.log(`wrote ${join(here, 'cordis.patch.yml')}`)
