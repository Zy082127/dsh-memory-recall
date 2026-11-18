// memory-recall · lib/db.js
// SQLite 只读访问（方案 A）：
//   只有在 <db>-shm 已存在时才建立只读连接，绝不创建 shm / wal，绝不 checkpoint。
//   已知副作用：打开时 SQLite 会触碰已存在的共享内存索引（-shm 的 mtime/映射）。
//   这不是"绝对零写入"：主库 memory.db 与 WAL 内容不被修改，也不新增文件。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** v0.1 只召回这四层；soul / user / project 不参与。 */
export const LEVELS = ['fact', 'lesson', 'topic', 'rules']

const SELECT_SQL = (level) =>
  `SELECT id, title, content, importance, keywords, status, project, source_session, updated_at FROM ${level} WHERE status = 'active'`

/** workspace → { conn, path } 的连接缓存；卸载时统一关闭。 */
const connections = new Map()

/** 行内 keywords 是 JSON 数组字符串；容错解析，坏值视为空数组。 */
function parseKeywords(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * 打开（或复用）某工作区的只读连接。
 * @returns {{ ok: true, conn: object, path: string } | { ok: false, reason: string, error?: string }}
 */
export function openReadOnly(workspace) {
  if (typeof workspace !== 'string' || workspace === '') return { ok: false, reason: 'no-workspace' }

  const dbPath = join(workspace, '.dsh-meow', 'memory.db')

  let stat
  try {
    stat = lstatSync(dbPath)
  } catch {
    return { ok: false, reason: 'missing-db' }
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink-db' }

  let real
  try {
    real = realpathSync(dbPath)
  } catch {
    return { ok: false, reason: 'unresolvable-db' }
  }
  const expectedRoot = resolve(workspace, '.dsh-meow') + sep
  if (!real.startsWith(expectedRoot)) return { ok: false, reason: 'db-outside-workspace' }

  const cached = connections.get(workspace)
  if (cached !== undefined) return { ok: true, conn: cached.conn, path: cached.path }

  // 方案 A 的核心闸门：没有现成的 -shm 就不开库，避免 SQLite 凭空创建 shm / 0 字节 wal。
  if (!existsSync(dbPath + '-shm')) return { ok: false, reason: 'no-shm' }

  try {
    const conn = new DatabaseSync(dbPath, { readOnly: true })
    // 连接级设置，不写库：遇到写者持锁时最多等 200ms 就放弃。
    conn.exec('PRAGMA busy_timeout = 200')
    connections.set(workspace, { conn, path: dbPath })
    return { ok: true, conn, path: dbPath }
  } catch (e) {
    return { ok: false, reason: 'open-failed', error: e?.code ?? String(e?.message ?? e) }
  }
}

/**
 * 读取四层 active 条目。表名来自常量白名单，不接受外部拼接。
 * @returns {{ ok: true, rows: object[] } | { ok: false, reason: string, error?: string }}
 */
export function loadEntries(conn) {
  const rows = []
  for (const level of LEVELS) {
    let batch
    try {
      batch = conn.prepare(SELECT_SQL(level)).all()
    } catch (e) {
      return { ok: false, reason: `read-${level}-failed`, error: e?.code ?? String(e?.message ?? e) }
    }
    for (const r of batch) {
      rows.push({
        id: String(r.id ?? ''),
        level,
        title: typeof r.title === 'string' ? r.title : '',
        content: typeof r.content === 'string' ? r.content : '',
        importance: Number.isFinite(r.importance) ? r.importance : 1,
        keywords: parseKeywords(r.keywords),
        project: typeof r.project === 'string' && r.project !== '' ? r.project : null,
        source_session: typeof r.source_session === 'string' ? r.source_session : null,
        updated_at: Number.isFinite(r.updated_at) ? r.updated_at : 0,
      })
    }
  }
  return { ok: true, rows }
}

/** 会话级"停止读入"开关。表或行缺失都视为未关闭（用户没表达过关闭意图）。 */
export function readSkipInject(conn, sessionId) {
  try {
    const row = conn.prepare('SELECT skip_inject FROM dream_skip WHERE session_id = ?').get(sessionId)
    return row?.skip_inject === 1
  } catch {
    return false
  }
}

/** 插件卸载时关闭全部连接。 */
export function closeAll() {
  for (const { conn } of connections.values()) {
    try {
      conn.close()
    } catch {
      /* 关闭失败不影响卸载 */
    }
  }
  connections.clear()
}
