// memory-recall · lib/home.js
// 定位 meow-memory 的 HomeDir 与工作区数据库路径；只读，不创建任何目录。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** DSH 根目录：环境变量优先，其次 ~/.dsh。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** meow-memory 的 HomeDir 指针文件（由它自己的 memory_home 工具写入）。 */
function homePointerFile() {
  return join(dshHome(), 'storages', 'meow-memory-home.json')
}

function readHomePointer() {
  try {
    const parsed = JSON.parse(readFileSync(homePointerFile(), 'utf8'))
    if (typeof parsed?.homeDir !== 'string') return undefined
    const r = resolve(parsed.homeDir.trim())
    if (!isAbsolute(r) || r === dirname(r) || r === resolve(homedir()) || !existsSync(r)) return undefined
    return r
  } catch {
    return undefined
  }
}

/**
 * 复刻 meow-memory 的 HomeDir 解析顺序（只读）：
 * MEOW_MEMORY_HOME（绝对路径 / dsh-storage 预设）→ 指针文件 → ~/.dsh-meow。
 * 不支持 plugin-root 预设（那需要 meow 插件自身目录，本插件不猜）。
 */
export function resolveMeowHome() {
  const env = process.env.MEOW_MEMORY_HOME
  if (typeof env === 'string' && env.trim() !== '') {
    const v = env.trim()
    if (v === 'dsh-storage') return join(dshHome(), 'storages', 'meow-memory')
    if (isAbsolute(v)) return resolve(v)
  }
  return readHomePointer() ?? join(homedir(), '.dsh-meow')
}

/** 工作区记忆库路径（v0.1 假定 meow 的 projectDir 为默认的 .dsh-meow）。 */
export function dbPathFor(workspace) {
  return join(workspace, '.dsh-meow', 'memory.db')
}

/** 与 meow-memory 完全一致的路径规范化：反斜杠转正斜杠、去尾斜杠、小写。 */
export function normalizeWorkspacePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

const GLOBAL_CANON = '全局'
const GLOBAL_CANON_EN = 'global'

/** 是否全局作用域（null / 空 / 「全局」/ global）。 */
export function isGlobalScope(field) {
  if (field === null || field === undefined) return true
  const t = String(field).trim()
  if (t === '') return true
  return t === GLOBAL_CANON || t.toLowerCase() === GLOBAL_CANON_EN
}

/** 逗号分隔的多项目字段 → 项目名数组。 */
export function projectList(field) {
  if (!field) return []
  if (isGlobalScope(field)) return []
  return String(field).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** 该条目的项目字段是否覆盖给定项目名。全局条目恒为 true。 */
export function projectCovers(field, name) {
  if (field === null || field === undefined) return true
  if (isGlobalScope(field)) return true
  if (typeof name !== 'string' || name === '') return false
  return projectList(field).includes(name)
}
