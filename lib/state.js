// memory-recall · lib/state.js
// 插件自己的注入状态与运行日志。只写 <stateDir>/，绝不写 meow 的 sessions / seen。
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_LOG_BYTES = 1024 * 1024

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}

export function sessionStatePath(stateDir, sessionId) {
  return join(stateDir, 'sessions', `${safeId(sessionId)}.json`)
}

/** 读取本会话已注入的 id 集合；损坏或缺失都视为空。 */
export function readSessionState(stateDir, sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(sessionStatePath(stateDir, sessionId), 'utf8'))
    return {
      injected: Array.isArray(parsed?.injected) ? parsed.injected.filter((x) => typeof x === 'string') : [],
      injectedAt: typeof parsed?.injectedAt === 'number' ? parsed.injectedAt : null,
    }
  } catch {
    return { injected: [], injectedAt: null }
  }
}

/** 原子写入（tmp + rename）；失败只返回 false，绝不抛给调用方。 */
export function writeSessionState(stateDir, sessionId, data) {
  try {
    mkdirSync(join(stateDir, 'sessions'), { recursive: true, mode: 0o700 })
    const target = sessionStatePath(stateDir, sessionId)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify({ injected: data.injected, injectedAt: data.injectedAt }), { mode: 0o600 })
    renameSync(tmp, target)
    return true
  } catch {
    return false
  }
}

/**
 * 追加一行 JSON 日志（JSONL）。超过 1MB 轮转成 recall.log.1。
 * 只记录 id / 分数 / 字符数 / 耗时 / 错误码，绝不记录记忆正文或用户消息。
 */
export function appendRecallLog(stateDir, entry) {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const file = join(stateDir, 'recall.log')
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`)
    } catch {
      /* 首次写入时文件还不存在 */
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  } catch {
    /* 日志失败不影响召回 */
  }
}
