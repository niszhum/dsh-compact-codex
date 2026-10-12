/**
 * 缓存的冷热判断与保活决策。
 *
 * 纯逻辑：`now` 与用量由调用方传入，不碰时钟、不调引擎。
 *
 * 规则：缓存过期后不再保活——过期的那条前缀已经失效，再发请求等于整段重写。
 */

/** 缓存的状态，由本插件自己观测和维护。 */
export function initialCacheState() {
	return {
		/** 最后一次真实请求开始的时间；没有基线时不保活。 */
		lastActivityAt: null,
		/** 那次请求读到 + 写过的缓存 token：缓存前缀的规模。 */
		cachedPrefixTokens: 0,
		/** 连续失败次数；到上限就停，而不是一直重试。 */
		consecutiveFailures: 0,
		/** 两次真实请求之间已发的保活次数。 */
		idleKeepalives: 0,
		/** 有一次保活正在飞。必须在发出之前置上：`fire()` 是异步的。 */
		inFlight: false
	}
}

export const WAIT_REASONS = {
	disabled: '未开启',
	busy: '会话正忙',
	stopped: '已停止',
	noBaseline: '还没有基线（没有真实请求）',
	prefixTooSmall: '前缀规模低于下限',
	expired: '缓存已过期（此时保活等于整段重写，不如等真实请求）',
	budgetSpent: '本轮空闲的保活次数已用完',
	notDue: '还没到保活点'
}

/**
 * 该不该现在保活。
 *
 * @param state - 本插件的缓存状态。
 * @param now - 当前时间（毫秒）。
 * @param config - 阈值：TTL、前缀下限、空闲预算、失败上限。
 * @param isBusy - 会话是否正在跑回合（跑着就不该插请求）。
 * @returns `{ action: 'fire' }`、`{ action: 'wait', reason, dueInMs? }` 或 `{ action: 'stop', reason }`。
 */
export function decideKeepalive(state, now, config, isBusy) {
	if (!config.enabled) return { action: 'wait', reason: 'disabled' }
	if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
		return { action: 'stop', reason: `连续 ${state.consecutiveFailures} 次保活失败，已停止` }
	}
	if (isBusy) return { action: 'wait', reason: 'busy' }
	if (state.lastActivityAt === null) return { action: 'wait', reason: 'noBaseline' }
	if (state.cachedPrefixTokens < config.minCacheReadTokens) return { action: 'wait', reason: 'prefixTooSmall' }

	const idle = now - state.lastActivityAt
	// 过期就别救了：那条缓存已经没了，再发请求是花钱重建一个马上要被真实请求重建的东西。
	if (idle >= config.ttlMs) return { action: 'wait', reason: 'expired' }
	if (state.idleKeepalives >= config.idleKeepaliveBudget) return { action: 'wait', reason: 'budgetSpent' }

	const dueInMs = config.keepaliveAfterMs - idle
	if (dueInMs > 0) return { action: 'wait', reason: 'notDue', dueInMs }
	return { action: 'fire' }
}

/** 上下文是否比跟踪中的前缀小了一大截（说明会话已经换过窗口）。 */
export function hasShrunk(contextTokens, cachedPrefixTokens) {
	return typeof contextTokens === 'number' && cachedPrefixTokens > 0 && contextTokens < cachedPrefixTokens / 2
}

/**
 * 从一次真实请求的用量里更新缓存状态，并把空闲计数归零。
 *
 * @param state - 就地更新。
 * @param usage - `{ cacheReadTokens, cacheWriteTokens }`，缺字段表示 provider 没报。
 * @param now - 请求开始时间。
 */
export function noteRequest(state, usage, now) {
	const read = typeof usage?.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
	const write = typeof usage?.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0
	state.lastActivityAt = now
	// 读到 + 写过的就是这条前缀的总量；都缺时保持原值，不要用一个假的 0 抹掉已知的规模。
	if (read > 0 || write > 0) state.cachedPrefixTokens = read + write
	state.idleKeepalives = 0
	state.consecutiveFailures = 0
}

/** 读数的文案：告诉模型缓存现在是什么状态，因为换窗的时机与它直接相关。 */
export function describeCache(state, config, now) {
	if (state.lastActivityAt === null) return '缓存：还没有可判断的基线'
	const idle = now - state.lastActivityAt
	const k = (tokens) => `${Math.round(tokens / 1000)}k`
	if (idle >= config.ttlMs) {
		return `缓存：已过期（空闲 ${Math.round(idle / 1000)} 秒，超过假设的 TTL ${Math.round(config.ttlMs / 1000)} 秒）——下一次请求要整段重写，此刻换窗的缓存代价最小`
	}
	const left = Math.max(0, config.ttlMs - idle)
	return `缓存：活着（前缀约 ${k(state.cachedPrefixTokens)}，还剩约 ${Math.round(left / 1000)} 秒）`
}
