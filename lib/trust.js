// memory-recall · lib/trust.js
// 工作区信任门的只读实现：fail-closed，绝不创建任何标记。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeWorkspacePath } from './home.js'

/**
 * 判定工作区是否被 meow-memory 信任。
 * 与原件相比多校验 path 一致性（原件只查 trustedAt 是数字，标记可被搬迁）。
 * 任何不确定（目录缺失、不可解析、字段不符）都返回 trusted:false。
 * @returns {{ trusted: boolean, reason: string }}
 */
export function checkTrust(homeDir, workspace) {
  if (typeof homeDir !== 'string' || homeDir === '') return { trusted: false, reason: 'no-home' }
  if (typeof workspace !== 'string' || workspace === '') return { trusted: false, reason: 'no-workspace' }

  const dir = join(homeDir, 'trusted-workspaces')
  if (!existsSync(dir)) return { trusted: false, reason: 'no-marker-dir' }

  const hash = createHash('sha256').update(normalizeWorkspacePath(workspace)).digest('hex')
  const file = join(dir, `${hash}.json`)
  if (!existsSync(file)) return { trusted: false, reason: 'no-marker' }

  try {
    const marker = JSON.parse(readFileSync(file, 'utf8'))
    if (marker === null || typeof marker !== 'object') return { trusted: false, reason: 'bad-marker' }
    if (typeof marker.trustedAt !== 'number' || !Number.isFinite(marker.trustedAt)) {
      return { trusted: false, reason: 'bad-trustedAt' }
    }
    if (typeof marker.path !== 'string') return { trusted: false, reason: 'missing-marker-path' }
    if (normalizeWorkspacePath(marker.path) !== normalizeWorkspacePath(workspace)) {
      return { trusted: false, reason: 'marker-path-mismatch' }
    }
    return { trusted: true, reason: 'ok' }
  } catch {
    return { trusted: false, reason: 'unreadable-marker' }
  }
}
