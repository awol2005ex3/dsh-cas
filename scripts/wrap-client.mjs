// 把 tsc 产出的 lib/client.js（纯模块体）包上闭包工厂外壳。
// 与 deepseek-harness packages/client/tsdown.client.ts 的 banner / intro / footer 契约一致。

import { readFileSync, writeFileSync } from 'node:fs'

const id = 'dsh-cas'
const path = new URL('../lib/client.js', import.meta.url)

let body = readFileSync(path, 'utf8')
body = body.replace(/\nexport \{\};?\s*$/, '\n')

const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`
const intro = 'var module = { exports: {} }; var exports = module.exports;'
const footer = 'return module.exports; } });'

writeFileSync(path, `${banner}\n${intro}\n${body}${footer}\n`)
console.log(`wrap-client: ${path.pathname} wrapped as ${id}`)