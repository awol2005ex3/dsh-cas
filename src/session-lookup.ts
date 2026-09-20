/**
 * 登录态查询所需的最小依赖。gate（/api 影子路由）与 http（/user-manager 路由）
 * 都要按 Cookie 取主体，但各自持有的依赖集合不同，这里抽公共部分。
 */

import type { ResolvedAuthConfig } from './types.js'

export interface AuthLookup {
  auth: ResolvedAuthConfig
  secret: string
  isRevoked: (jti: string) => boolean
}
