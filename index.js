// memory-recall · index.js
// 跨项目记忆召回：只读 meow-memory 的工作区数据库，把相关历史记忆静默注入 decision。
// 设计约束：不 import meow 模块、不调它的写接口、不碰它的 seen / sessions / 信任标记。
// 自检不通过（拿不到公开的 createUserMessage）时全程静默，绝不注入。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeAll, loadEntries, openReadOnly, readSkipInject } from './lib/db.js'
import { dshHome, resolveMeowHome } from './lib/home.js'
import { plan } from './lib/recall.js'
import { appendRecallLog, readSessionState, writeSessionState } from './lib/state.js'
import { checkTrust } from './lib/trust.js'

export const name = 'memory-recall'

const ENABLED = true
const MAX_ITEMS = 3
const MAX_CHARS = 900
const MIN_REL = 0.45
const SOURCE_KIND = 'memory-recall'
/** 五项目检：与宿主 message 工厂的契约逐项对齐。 */
export function passesFactoryContract(message) {
  return (
    typeof message?.id === 'string' &&
    message?.role === 'user' &&
    message?.source?.kind === SOURCE_KIND &&
    Array.isArray(message?.content) &&
    Object.isFrozen(message) === true
  )
}

/** 只读 meow 的会话账本，取它已经注入过的 id（用于避免重复）。 */
function readMeowInjected(workspace, sessionId) {
  try {
    const file = join(workspace, '.dsh-meow', 'sessions', `${sessionId}.json`)
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed?.injected) ? parsed.injected.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** meow 记录的当前项目名（用户最后一次 memory_project 选择）；没有就返回 null。 */
function readCurrentProject(workspace, sessionId) {
  try {
    const file = join(workspace, '.dsh-meow', 'sessions', `${sessionId}.json`)
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed?.currentProject === 'string' && parsed.currentProject !== '' ? parsed.currentProject : null
  } catch {
    return null
  }
}

function textOfUserMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
}

export async function apply(ctx) {
  const stateDir = join(dshHome(), 'storages', 'memory-recall')
  const meowHome = resolveMeowHome()

  // ---- 启动自检：模块解析 + 导出可调用 + 真调一次的五项契约 ----
  const factory = {
    moduleImported: false,
    exportCallable: false,
    factoryCallSucceeded: false,
    verified: false,
    importError: null,
    factoryCallError: null,
  }
  let createUserMessage = null
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    factory.moduleImported = true
    createUserMessage = mod.createUserMessage
    factory.exportCallable = typeof createUserMessage === 'function'
  } catch (e) {
    factory.importError = e?.code ?? String(e?.message ?? e)
  }

  if (factory.exportCallable) {
    try {
      const selfTest = createUserMessage({
        content: [{ type: 'text', text: 'memory-recall self-test (never injected)' }],
        source: { kind: SOURCE_KIND, form: 'notice', summary: 'self-test' },
      })
      factory.factoryCallSucceeded = passesFactoryContract(selfTest)
      if (!factory.factoryCallSucceeded) factory.factoryCallError = 'contract-check-failed'
    } catch (e) {
      factory.factoryCallError = e?.code ?? String(e?.message ?? e)
    }
  }
  factory.verified = factory.moduleImported && factory.exportCallable && factory.factoryCallSucceeded

  appendRecallLog(stateDir, {
    at: Date.now(),
    stage: 'apply',
    factory,
    meowHome,
    stateDir,
    limits: { maxItems: MAX_ITEMS, maxChars: MAX_CHARS, minRel: MIN_REL },
  })

  if (!factory.verified) {
    try {
      ctx.logger.warn(
        `memory-recall: 消息工厂自检未通过（${factory.importError ?? factory.factoryCallError ?? 'unknown'}），插件保持静默`,
      )
    } catch {
      /* 日志失败不影响加载 */
    }
  }

  // 卸载时关闭全部只读连接。
  ctx.effect(() => () => closeAll())

  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next()
      const t0 = Date.now()
      try {
        if (!ENABLED || !factory.verified) return decision
        if (decision?.kind !== 'enter') return decision

        const { agent, signal } = payload ?? {}
        if (signal?.aborted) return decision
        if (agent?.session?.header?.origin === 'subagent') return decision

        const messages = Array.isArray(decision.messages) ? decision.messages : []
        const userMsgs = messages.filter((m) => m?.source?.kind === 'user')
        if (userMsgs.length === 0) return decision

        const workspace = agent?.session?.header?.cwd
        const sessionId = agent?.session?.header?.id
        if (typeof workspace !== 'string' || workspace === '') return decision
        if (typeof sessionId !== 'string' || sessionId === '') return decision

        const sid = sessionId.slice(0, 12)

        // 1) 信任门：fail-closed
        const trust = checkTrust(meowHome, workspace)
        if (!trust.trusted) {
          appendRecallLog(stateDir, { at: Date.now(), stage: 'skip', sid, reason: `untrusted:${trust.reason}` })
          return decision
        }

        // 2) 只读开库（方案 A：无 -shm 就不开）
        const opened = openReadOnly(workspace)
        if (!opened.ok) {
          appendRecallLog(stateDir, { at: Date.now(), stage: 'skip', sid, reason: `db:${opened.reason}` })
          return decision
        }

        // 3) 会话级"停止读入"开关
        if (readSkipInject(opened.conn, sessionId)) {
          appendRecallLog(stateDir, { at: Date.now(), stage: 'skip', sid, reason: 'skip-inject' })
          return decision
        }

        // 4) 去重：meow seen + 自己的 state + 模型可见历史
        const excluded = new Set()
        for (const id of readMeowInjected(workspace, sessionId)) excluded.add(id)
        const own = readSessionState(stateDir, sessionId)
        for (const id of own.injected) excluded.add(id)

        let historyAlreadyHasOurs = false
        try {
          if (typeof agent?.session?.deriveMessages === 'function') {
            historyAlreadyHasOurs = agent.session.deriveMessages().some((m) => m?.source?.kind === SOURCE_KIND)
          }
        } catch {
          /* 读不到历史就不当作已注入 */
        }
        if (historyAlreadyHasOurs) {
          appendRecallLog(stateDir, { at: Date.now(), stage: 'skip', sid, reason: 'already-in-history' })
          return decision
        }

        // 5) 读候选（四层 active）
        const loaded = loadEntries(opened.conn)
        if (!loaded.ok) {
          appendRecallLog(stateDir, { at: Date.now(), stage: 'skip', sid, reason: `read:${loaded.reason}` })
          return decision
        }

        // 6) 打分与预算
        const queryText = textOfUserMessage(userMsgs[userMsgs.length - 1])
        const result = plan({
          rows: loaded.rows,
          queryText,
          currentProject: readCurrentProject(workspace, sessionId),
          currentSession: sessionId,
          excludedIds: excluded,
          now: Date.now(),
          limits: { maxItems: MAX_ITEMS, maxChars: MAX_CHARS, minRel: MIN_REL },
        })

        if (result.items.length === 0) {
          appendRecallLog(stateDir, {
            at: Date.now(),
            stage: 'empty',
            sid,
            candidates: result.candidates,
            ms: Date.now() - t0,
          })
          return decision
        }

        // 7) 组消息并插入
        const message = createUserMessage({
          content: [{ type: 'text', text: result.text }],
          source: { kind: SOURCE_KIND, form: 'notice', summary: `召回 ${result.items.length} 条历史记忆` },
        })
        if (!passesFactoryContract(message)) {
          appendRecallLog(stateDir, { at: Date.now(), stage: 'skip', sid, reason: 'message-contract' })
          return decision
        }

        const target = userMsgs[userMsgs.length - 1]
        const rewritten = [...messages]
        const at = rewritten.indexOf(target)
        rewritten.splice(at < 0 ? rewritten.length : at, 0, message)

        // 8) 先记账再返回（注入已成立）
        const nextInjected = [...new Set([...own.injected, ...result.items.map((i) => i.id)])]
        writeSessionState(stateDir, sessionId, { injected: nextInjected, injectedAt: Date.now() })
        appendRecallLog(stateDir, {
          at: Date.now(),
          stage: 'inject',
          sid,
          ids: result.items.map((i) => i.id),
          levels: result.items.map((i) => i.level),
          scores: result.items.map((i) => Math.round(i.score * 1000) / 1000),
          chars: result.chars,
          candidates: result.candidates,
          ms: Date.now() - t0,
        })

        return { ...decision, messages: rewritten }
      } catch (e) {
        appendRecallLog(stateDir, {
          at: Date.now(),
          stage: 'error',
          error: e?.code ?? String(e?.message ?? e),
          ms: Date.now() - t0,
        })
        return decision
      }
    },
    { prepend: true },
  )
}
