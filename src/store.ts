/**
 * 插件状态落盘：页面可改的 CAS 连接配置 + 会话归属索引。
 *
 * 归属索引是「按用户隔离」的唯一权威来源。它不依赖 harness 内部结构 ——
 * 会话本身不带 owner 字段，我们只在 session.create 时记一笔映射，
 * 并在列举 / 访问类方法上按索引过滤与拒绝。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, stringify } from 'yaml'
import type { CasConfig } from './types.js'

/** 落盘结构。 */
interface StateFile {
  /** 页面保存的 CAS 连接配置（页面改配置优先于 profile 配置）。 */
  cas?: CasConfig
  /** 用户 id → 其拥有的会话 id 列表。 */
  ownership: Record<string, string[]>
}

/** 会话归属策略所需的一次性判定结果。 */
export type OwnershipVerdict = 'owner' | 'unowned' | 'other'

/**
 * 状态存储。所有变更同步落盘（本插件状态很小，同步写保证重启后不丢归属）。
 */
export class StateStore {
  private cas: CasConfig | undefined
  /** 会话 id → 拥有者用户 id（与落盘结构互为倒置，便于列举时 O(1) 判定）。 */
  private readonly ownerOf = new Map<string, string>()
  /** 用户 id → 会话 id 列表（保持创建顺序，落盘用）。 */
  private readonly sessionsOf = new Map<string, string[]>()

  constructor(private readonly path: string) {}

  /** 读取状态文件；文件不存在视为空状态，其他读取错误向上抛。 */
  load(): void {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    const data = parse(raw) as Partial<StateFile> | null | undefined
    if (data === null || data === undefined) return
    if (data.cas !== undefined) this.cas = data.cas
    const ownership = data.ownership ?? {}
    for (const [userId, sessionIds] of Object.entries(ownership)) {
      if (!Array.isArray(sessionIds)) continue
      const list: string[] = []
      for (const sessionId of sessionIds) {
        if (typeof sessionId !== 'string' || sessionId === '') continue
        list.push(sessionId)
        this.ownerOf.set(sessionId, userId)
      }
      if (list.length > 0) this.sessionsOf.set(userId, list)
    }
  }

  /** 写回状态文件（自动建目录）。 */
  save(): void {
    const ownership: Record<string, string[]> = {}
    for (const [userId, sessionIds] of this.sessionsOf) {
      if (sessionIds.length > 0) ownership[userId] = [...sessionIds]
    }
    const data: StateFile = {
      ownership,
      ...(this.cas === undefined ? {} : { cas: this.cas }),
    }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, stringify(data), 'utf8')
  }

  /* ── 页面可改的 CAS 连接配置 ── */

  /** 页面保存的 CAS 配置；未保存过返回 undefined（回落 profile 配置）。 */
  getCas(): CasConfig | undefined {
    return this.cas
  }

  /** 覆盖页面配置并落盘。 */
  setCas(cas: CasConfig): void {
    this.cas = cas
    this.save()
  }

  /* ── 会话归属 ── */

  /** 记一笔归属（重复登记幂等）。 */
  claim(sessionId: string, userId: string): void {
    const previous = this.ownerOf.get(sessionId)
    if (previous === userId) return
    if (previous !== undefined) this.unlink(previous, sessionId)
    this.ownerOf.set(sessionId, userId)
    const list = this.sessionsOf.get(userId)
    if (list === undefined) this.sessionsOf.set(userId, [sessionId])
    else list.push(sessionId)
  }

  /** 解除某会话的归属（删除会话时用）。 */
  release(sessionId: string): void {
    const owner = this.ownerOf.get(sessionId)
    if (owner === undefined) return
    this.unlink(owner, sessionId)
    this.ownerOf.delete(sessionId)
  }

  /** 某会话归属于谁；无记录返回 undefined。 */
  ownerOfSession(sessionId: string): string | undefined {
    return this.ownerOf.get(sessionId)
  }

  /** 判定会话相对某用户的归属关系。 */
  verdict(sessionId: string, userId: string): OwnershipVerdict {
    const owner = this.ownerOf.get(sessionId)
    if (owner === undefined) return 'unowned'
    return owner === userId ? 'owner' : 'other'
  }

  /** 某用户拥有的全部会话 id。 */
  sessionsOfUser(userId: string): string[] {
    return [...(this.sessionsOf.get(userId) ?? [])]
  }

  /** 归属索引规模（自检 / 日志用）。 */
  get size(): number {
    return this.ownerOf.size
  }

  private unlink(userId: string, sessionId: string): void {
    const list = this.sessionsOf.get(userId)
    if (list === undefined) return
    const at = list.indexOf(sessionId)
    if (at >= 0) list.splice(at, 1)
    if (list.length === 0) this.sessionsOf.delete(userId)
  }
}