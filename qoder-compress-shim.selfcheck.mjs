/**
 * qoder 压缩 shim 的离线自检。
 *
 * 覆盖两处真实缺陷（都是 `ofm-qoder` 报 `unreachable` / `已 dispose` 的成因）：
 *
 *   A. pack.js 的 `withStrings` 在 finally 里释放 **输入** 字符串。那些指针的所有权
 *      在调用时已归 Rust，JS 再释放一遍会写坏 Rust 堆的分配元数据 ⇒ 下一次 wasm
 *      调用 trap `RuntimeError: unreachable`。修法是删掉那次释放。
 *   B. adapter 的 `buildRequest` 在 `finally` 里 `dispose()` 加密器，而 shim 要等 bili
 *      压缩完才重新加密 ⇒ 必然撞上「已 dispose」。修法是把 dispose 推迟到 shim 用完。
 *
 * 不联网、不启动宿主：用真实的 wasm 与真实的 shim 模块，只把上游换成本地桩。
 *
 * 用法：node qoder-compress-shim.selfcheck.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = process.env.DSH_HOME ?? 'D:\\ai\\dsh\\home'
const SHIM = join(HOME, 'plugins', 'model-failover-manager', 'qoder-compress-shim.mjs')
const HUB_WASM = join(HOME, 'profiles', 'web', 'node_modules', 'dsh-providers-hub', 'lib', 'qoder-wasm.js')
const PACK = join(HOME, 'profiles', 'web', 'node_modules', 'dsh-our-free-model', 'vendor', 'channel-pack', 'pack.js')

const results = []
const check = async (name, fn) => {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log('PASS  ' + name)
  } catch (err) {
    results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) })
    console.log('FAIL  ' + name + '\n        ' + (err && err.message ? err.message : String(err)))
  }
}

// ── A. 输入串释放补丁 ────────────────────────────────────────────────────────
await check('A1 pack.js 补丁能唯一定位并改掉输入串释放', async () => {
  const MARK = '输入串所有权在调用时已归 Rust'
  const bad = '      for (let i = 0; i < pointers.length; i++) freeString(pointers[i], lengths[i]);'
  // 用原始副本（宿主里那份可能已被补过）验证补丁函数本身。
  const original = PACK + '.bak-mfm-inputfree'
  let source = PACK
  try { readFileSync(original); source = original } catch { /* 没有备份就用当前文件 */ }
  const dir = mkdtempSync(join(tmpdir(), 'qoder-selfcheck-'))
  const copy = join(dir, 'pack.js')
  copyFileSync(source, copy)
  const before = readFileSync(copy, 'utf8')
  if (before.includes(MARK)) {
    // 备份本身已是修好的形态：那种情况下只核对「已修」这一侧。
    assert.equal(before.includes(bad), false, '已修的文件不应再含待修片段')
    return
  }
  assert.equal(before.split(bad).length - 1, 1, '待修片段应恰好出现 1 次')

  // 把 ensurePackStringFix 单独抠出来跑（它是顶层的纯函数，不依赖模块其余部分）。
  const src = readFileSync(SHIM, 'utf8')
  const start = src.indexOf('function ensurePackStringFix(packPath) {')
  const end = src.indexOf('\n}\n', start) + 3
  assert.ok(start > 0 && end > start, '应能在 shim 里定位 ensurePackStringFix')
  const mod = await import('data:text/javascript,' + encodeURIComponent(
    "import { readFileSync, writeFileSync } from 'node:fs'\n" + src.slice(start, end) + '\nexport { ensurePackStringFix }'))
  const first = mod.ensurePackStringFix(copy)
  assert.equal(first.state, 'repaired', '首次应报告已修')
  const after = readFileSync(copy, 'utf8')
  assert.equal(after.includes(bad), false, '待修片段必须消失')
  assert.equal(after.includes(MARK), true, '必须留下修复标记')
  assert.equal(/finally\s*\n?\s*\/\/ 输入串/.test(after), false, '不应留下空的 try/finally')
  const second = mod.ensurePackStringFix(copy)
  assert.equal(second.state, 'ok', '二次运行必须幂等（不重复插入）')
})

await check('A2 释放输入串会让 wasm 堆在下一次调用 trap', async () => {
  const { QoderEncryptedInfer } = await import(pathToFileURL(HUB_WASM).href)
  const opts = { user: { uid: 'u', securityOauthToken: 't' }, machineId: 'm', metadata: { a: 1 }, host: 'https://qoder.com/x' }
  // hub 的 glue 里 freeString 走 __wbindgen_export4，与 pack.js 的 freeString 同一 ABI。
  const c = await QoderEncryptedInfer.create(opts)
  const g = c.g
  const body = JSON.stringify({ m: 'z'.repeat(3000) })
  const ptrs = []
  const lens = []
  const w = (t) => { const p = g.writeString(t); ptrs.push(p); lens.push(g.lastLength()); return p }
  const host = w(c.host)
  const b = w(body)
  const k = w('dfmodel')
  const s = w('system')
  let result
  try {
    result = g.callPointer((stack) => g.exports.qodercontext_prepareInferRequest(stack, c.context, host, lens[0], b, lens[1], k, lens[2], s, lens[3]))
  } finally {
    // 这正是 pack.js 的 finally 所做的事。
    for (let i = 0; i < ptrs.length; i++) { try { g.freeString(ptrs[i], lens[i]) } catch { /* 已记下，下一次调用才是判据 */ } }
  }
  assert.ok(result > 0, '首次 prepareInfer 应成功（缺陷是**下一次**调用才炸）')
  let trapped = false
  try {
    const h2 = g.writeString(c.host)
    const b2 = g.writeString(body)
    const k2 = g.writeString('dfmodel')
    const s2 = g.writeString('system')
    g.callPointer((stack) => g.exports.qodercontext_prepareInferRequest(stack, c.context, h2, g.lastLength(), b2, g.lastLength(), k2, g.lastLength(), s2, g.lastLength()))
  } catch (err) {
    trapped = /unreachable|memory access out of bounds/i.test(String(err && err.message))
  }
  assert.equal(trapped, true, '释放输入串后，下一次 wasm 调用必须 trap —— 否则本用例的前提不成立')
})

await check('A3 不释放输入串时连续 300 次 prepareInfer 全部成功', async () => {
  const { QoderEncryptedInfer } = await import(pathToFileURL(HUB_WASM).href)
  const opts = { user: { uid: 'u', securityOauthToken: 't' }, machineId: 'm', metadata: { a: 1 }, host: 'https://qoder.com/x' }
  let ok = 0
  for (let i = 0; i < 300; i += 1) {
    const c = await QoderEncryptedInfer.create(opts)
    const g = c.g
    const body = JSON.stringify({ m: 'z'.repeat(3000) })
    const host = g.writeString(c.host)
    const hl = g.lastLength()
    const b = g.writeString(body)
    const bl = g.lastLength()
    const k = g.writeString('dfmodel')
    const kl = g.lastLength()
    const s = g.writeString('system')
    const sl = g.lastLength()
    const result = g.callPointer((stack) => g.exports.qodercontext_prepareInferRequest(stack, c.context, host, hl, b, bl, k, kl, s, sl))
    g.freePointer('__wbg_requestresult_free', result)
    c.dispose()
    ok += 1
  }
  assert.equal(ok, 300)
})

// ── C. context 延迟归还补丁 ─────────────────────────────────────────────────
await check('C1 pack.js 补丁给 buildRequest 装上「延迟归还」，而不是立刻释放', async () => {
  const MARK = 'QoderContext 延迟归还（__wbg_qodercontext_free）'
  const MARK_V1 = 'QoderContext 归还（__wbg_qodercontext_free）'
  const openOld = '      return client.prepareInfer({'
  const bad = '        business: { type: "agent" }\n      });\n    };'
  // 用备份副本验证补丁函数本身（当前宿主的 pack.js 已被打过这个补丁）。
  let source = PACK
  for (const bak of [PACK + '.bak-mfm-ctxfree', PACK + '.bak-mfm-inputfree']) {
    try { readFileSync(bak); source = bak; break } catch { /* 用当前文件 */ }
  }
  const dir = mkdtempSync(join(tmpdir(), 'qoder-ctxfree-'))
  const copy = join(dir, 'pack.js')
  copyFileSync(source, copy)

  const src = readFileSync(SHIM, 'utf8')
  const start = src.indexOf('function stripContextBlock(')
  const end = src.indexOf('function ensurePackResultFree(')
  assert.ok(start > 0 && end > start, '应能在 shim 里定位 ensurePackContextFree')
  const mod = await import('data:text/javascript,' + encodeURIComponent(
    "import { readFileSync, writeFileSync } from 'node:fs'\n" + src.slice(start, end) + '\nexport { ensurePackContextFree }'))
  const before = readFileSync(copy, 'utf8')
  // 备份若已被打过补丁，这份用例的前提就不成立，跳过而不是假装通过。
  // 注意：v1 标记也算「已打过」——v1 会立刻释放，正是要修掉的形态。
  if (before.includes(MARK)) return
  assert.equal(before.includes(openOld), true, '待补丁文件里应存在 `return client.prepareInfer({`')
  assert.equal(before.includes(MARK_V1), false, 'v1 立刻释放的形态不该出现在待补丁副本里')

  const first = mod.ensurePackContextFree(copy)
  assert.equal(first.state, 'repaired', '首次应报告已修')
  const after = readFileSync(copy, 'utf8')
  assert.equal(after.includes(MARK), true, '必须留下补丁标记')
  // 核心断言：绝不能立刻释放 context。shim 要借同一实例重新加密，一释放就 trap。
  assert.equal(after.includes('__wbg_qodercontext_free(client.context, 0)'), false,
    '不得在 buildRequest 的 finally 里立刻释放 context（会让 shim 的二次加密 trap）')
  assert.match(after, /client\[releaseKey\] = \(\) =>/, '归还必须挂到实例上，由 release() 执行')
  assert.equal(after.includes("Symbol.for('mf.qoder.deferredRelease')"), true,
    "归还用的键必须与 shim 的 RELEASE_KEY 同一个 Symbol")
  // C 补丁只动 context，不得动输入串。所用备份可能早于 A 补丁，
  // 所以只能做「前后同一」的比较，不能假定源文件里一定没有那次释放。
  assert.equal(after.split('freeString(pointers').length - 1,
    before.split('freeString(pointers').length - 1, 'C 补丁不得改动输入串释放')
  const second = mod.ensurePackContextFree(copy)
  assert.equal(second.state, 'ok', '二次运行必须幂等（不重复插入）')
})

await check('C1b v1 立刻释放的补丁能被就地迁移成延迟归还', async () => {
  const MARK = 'QoderContext 延迟归还（__wbg_qodercontext_free）'
  const MARK_V1 = 'QoderContext 归还（__wbg_qodercontext_free）'
  // 造一份「已经装过 v1」的文件：这是 v1 在用户机器上留下的真实形态。
  let source = PACK
  for (const bak of [PACK + '.bak-mfm-ctxfree', PACK + '.bak-mfm-inputfree']) {
    try { readFileSync(bak); source = bak; break } catch { /* 用当前文件 */ }
  }
  const dir = mkdtempSync(join(tmpdir(), 'qoder-ctxmigrate-'))
  const copy = join(dir, 'pack.js')
  copyFileSync(source, copy)

  const src = readFileSync(SHIM, 'utf8')
  const start = src.indexOf('function stripContextBlock(')
  const end = src.indexOf('function ensurePackResultFree(')
  const mod = await import('data:text/javascript,' + encodeURIComponent(
    "import { readFileSync, writeFileSync } from 'node:fs'\n" + src.slice(start, end) + '\nexport { ensurePackContextFree, stripContextBlock }'))
  const pre = readFileSync(copy, 'utf8')
  if (!pre.includes(MARK) && pre.includes('      return client.prepareInfer({')) {
    mod.ensurePackContextFree(copy)
  }
  let text = readFileSync(copy, 'utf8')
  if (!text.includes(MARK)) return
  // 按标记行定位 v2 块（不能用 `[\s\S]*?` 从文件头扫：前面还有别的 `} finally {`）。
  const markAt = text.indexOf('        // ' + MARK + '：本类没有 dispose')
  assert.ok(markAt > 0, '当前形态里应能定位 v2 延迟归还块的注释')
  const headAt = text.lastIndexOf('      } finally {\n', markAt)
  const tailAt = text.indexOf('\n      }\n', markAt)
  assert.ok(headAt > 0 && tailAt > headAt, '当前形态里应能框住 v2 延迟归还块')
  const v1 = [
    '      } finally {',
    '        // ' + MARK_V1 + '：本类没有 dispose，每次推理新建的 context 只能在这里还回去。',
    '        // 只释放 context，不碰 create 的输入串（那些所有权已归 Rust）。',
    '        try { if (client.context) client.g.exports.__wbg_qodercontext_free(client.context, 0) } catch { /* 释放失败不影响本次请求 */ }',
    '      }',
    '', // 末尾换行：缺了它 v1 的 `}` 会和后面的 `};` 粘成一行，块边界就失配了
  ].join('\n')
  writeFileSync(copy, text.slice(0, headAt) + v1 + text.slice(tailAt + '\n      }\n'.length), 'utf8')
  const v1Text = readFileSync(copy, 'utf8')
  assert.equal(v1Text.includes(MARK_V1), true, '构造出的 v1 形态应带 v1 标记')
  assert.equal(v1Text.includes(MARK), false, '构造出的 v1 形态不该带 v2 标记')

  const migrated = mod.ensurePackContextFree(copy)
  assert.equal(migrated.state, 'repaired', '应把 v1 就地迁移成 v2')
  const final = readFileSync(copy, 'utf8')
  assert.equal(final.includes(MARK_V1), false, '迁移后不得残留 v1 标记')
  assert.equal(final.includes(MARK), true, '迁移后应带 v2 标记')
  assert.equal(final.includes('__wbg_qodercontext_free(client.context, 0)'), false, '迁移后不得立刻释放')
  // 迁移必须是「把 v1 原样退回、再装一遍 v2」，所以结果要与从未装过 v1 的形态逐字节一致。
  // 这比 `new Function()` 更能证明结构正确：ESM 文件本来就不能用 Function 解析，
  // 而任何残留的半截 `try {`、多出来的 `} finally {` 都会让这份比较失败。
  assert.equal(final, text, '迁移后的文件必须与「干净源码直接补成 v2」逐字节一致')
  assert.equal(mod.stripContextBlock(final, MARK) !== null, true, '迁移后应恰好有一段结构完好的归还块')
})

await check('C1c 立刻归还 context 会让二次加密失败，延迟归还不会', async () => {
  const { QoderEncryptedInfer } = await import(pathToFileURL(HUB_WASM).href)
  const RELEASE_KEY = Symbol.for('mf.qoder.deferredRelease')
  const opts = { user: { uid: 'u', securityOauthToken: 't' }, machineId: 'm', metadata: { a: 1 }, host: 'https://qoder.com/x' }
  const ask = { modelKey: 'dfmodel', userText: 'hi', history: [{ role: 'user', content: 'hello' }], tools: [], business: { type: 'agent' } }

  // 反例：v1 的立刻释放。第二次加密必须失败 —— 这就是用户看到的 `unreachable` 来源。
  const bad = await QoderEncryptedInfer.create(opts)
  bad.prepareInfer(ask)
  try { bad.g.exports.__wbg_qodercontext_free(bad.context, 0) } catch { /* 记过即可 */ }
  assert.throws(() => bad.prepareInfer(ask), /unreachable|out of bounds/,
    '立刻归还后二次加密必须失败（本用例证明 v1 就是那个 bug）')

  // 正例：v2 的延迟归还。两次加密都要成功，release() 之后才失效。
  const good = await QoderEncryptedInfer.create(opts)
  good.prepareInfer(ask)
  const owned = good.context
  good[RELEASE_KEY] = () => { try { good.g.exports.__wbg_qodercontext_free(owned, 0) } catch { /* 已释放过 */ } }
  assert.doesNotThrow(() => good.prepareInfer(ask), '延迟归还未执行前，二次加密必须成功')
  good[RELEASE_KEY]()
  assert.throws(() => good.prepareInfer(ask), /unreachable|out of bounds|已 dispose/,
    'release() 之后二次加密才该失败')
})

await check('C2 归还 context 后 wasm 内存进入平台期（不归还则线性增长）', async () => {
  const { QoderEncryptedInfer } = await import(pathToFileURL(HUB_WASM).href)
  const opts = { user: { uid: 'u', securityOauthToken: 't' }, machineId: 'm', metadata: { a: 1 }, host: 'https://qoder.com/x' }
  const ask = { modelKey: 'dfmodel', userText: 'u'.repeat(40000), history: [], tools: [], business: { type: 'agent' } }
  const mem = async () => (await QoderEncryptedInfer.create(opts)).g.exports.memory.buffer.byteLength
  const run = async (free, n) => {
    for (let i = 0; i < n; i += 1) {
      const c = await QoderEncryptedInfer.create(opts)
      try { c.prepareInfer(ask) } finally { if (free) { try { c.g.exports.__wbg_qodercontext_free(c.context, 0) } catch { /* 已记 */ } } }
    }
    return mem()
  }
  const base = await mem()
  const freedA = ((await run(true, 200)) - base) / 1048576
  const freedB = ((await run(true, 400)) - base) / 1048576
  assert.ok(Math.abs(freedB - freedA) < 0.2, `归还 context 后内存应停在平台期，实测 200→${freedA.toFixed(2)}MB 400→${freedB.toFixed(2)}MB`)
  const leakA = ((await run(false, 200)) - base) / 1048576
  const leakB = ((await run(false, 400)) - base) / 1048576
  assert.ok(leakB > leakA + 0.2, `不归还必须持续增长（否则本用例前提不成立）：200→${leakA.toFixed(2)}MB 400→${leakB.toFixed(2)}MB`)
})

// ── D. result 归还补丁 ──────────────────────────────────────────────────────
await check('D1 pack.js 补丁能给 prepareInfer 装上 requestresult 归还', async () => {
  const MARK = 'requestresult 归还（__wbg_requestresult_free）'
  const openOld = '    return {\n      // ⚠️ 参数顺序：(栈指针, ptr) —— 与直觉相反'
  let source = PACK
  for (const bak of [PACK + '.bak-mfm-resultfree', PACK + '.bak-mfm-ctxfree', PACK + '.bak-mfm-inputfree']) {
    try { readFileSync(bak); source = bak; break } catch { /* 用当前文件 */ }
  }
  const dir = mkdtempSync(join(tmpdir(), 'qoder-resultfree-'))
  const copy = join(dir, 'pack.js')
  copyFileSync(source, copy)

  const src = readFileSync(SHIM, 'utf8')
  const start = src.indexOf('function ensurePackResultFree(packPath) {')
  const end = src.indexOf('\n}\n', start) + 3
  assert.ok(start > 0 && end > start, '应能在 shim 里定位 ensurePackResultFree')
  const mod = await import('data:text/javascript,' + encodeURIComponent(
    "import { readFileSync, writeFileSync } from 'node:fs'\n" + src.slice(start, end) + '\nexport { ensurePackResultFree }'))
  const before = readFileSync(copy, 'utf8')
  if (before.includes(MARK)) return
  assert.equal(before.includes(openOld), true, '待补丁文件里应存在 result 读取块的起头')

  const first = mod.ensurePackResultFree(copy)
  assert.equal(first.state, 'repaired', '首次应报告已修')
  const after = readFileSync(copy, 'utf8')
  assert.equal(after.includes(MARK), true, '必须留下补丁标记')
  assert.match(after, /__wbg_requestresult_free\(result, 0\)/, '必须释放 result')
  // 输入串绝不能动：那是 Rust 持有的，多放一次就会 trap。
  assert.equal(after.split('freeString(pointers').length - 1,
    before.split('freeString(pointers').length - 1, 'D 补丁不得改动输入串释放')
  const second = mod.ensurePackResultFree(copy)
  assert.equal(second.state, 'ok', '二次运行必须幂等（不重复插入）')
})

await check('D2 归还 result 才是内存平台期的关键（只还 context 仍线性增长）', async () => {
  const { QoderEncryptedInfer } = await import(pathToFileURL(HUB_WASM).href)
  const opts = { user: { uid: 'u', securityOauthToken: 't' }, machineId: 'm', metadata: { a: 1 }, host: 'https://qoder.com/x' }
  const body = JSON.stringify({ m: 'y'.repeat(40000) })
  const mem = async () => (await QoderEncryptedInfer.create(opts)).g.exports.memory.buffer.byteLength
  const run = async (freeResult, n) => {
    for (let i = 0; i < n; i += 1) {
      const c = await QoderEncryptedInfer.create(opts)
      const g = c.g
      const h = g.writeString(c.host); const hl = g.lastLength()
      const b = g.writeString(body); const bl = g.lastLength()
      const k = g.writeString('dfmodel'); const kl = g.lastLength()
      const s = g.writeString('system'); const sl = g.lastLength()
      const r = g.callPointer((st) => g.exports.qodercontext_prepareInferRequest(st, c.context, h, hl, b, bl, k, kl, s, sl))
      if (freeResult) g.freePointer('__wbg_requestresult_free', r)
      g.freePointer('__wbg_qodercontext_free', c.context)
    }
    return mem()
  }
  const base = await mem()
  const bothA = ((await run(true, 100)) - base) / 1048576
  const bothB = ((await run(true, 200)) - base) / 1048576
  const ctxA = ((await run(false, 100)) - base) / 1048576
  const ctxB = ((await run(false, 200)) - base) / 1048576
  assert.ok(Math.abs(bothB - bothA) < 0.3, `只还 context+result 应停在平台期：100→${bothA.toFixed(2)}MB 200→${bothB.toFixed(2)}MB`)
  assert.ok(ctxB > ctxA + 0.3, `只还 context 仍必须增长（否则本用例前提不成立）：100→${ctxA.toFixed(2)}MB 200→${ctxB.toFixed(2)}MB`)
})

// ── B. dispose 推迟 ──────────────────────────────────────────────────────────
await check('B1 adapter 的顺序（return + finally dispose）会撞上「已 dispose」', async () => {
  const { QoderEncryptedInfer } = await import(pathToFileURL(HUB_WASM).href)
  const opts = { user: { uid: 'u', securityOauthToken: 't' }, machineId: 'm', metadata: { a: 1 }, host: 'https://qoder.com/x' }
  const ask = { modelKey: 'dfmodel', userText: 'hi', history: [], tools: [], business: { type: 'agent' } }
  const c = await QoderEncryptedInfer.create(opts)
  c.prepareInfer(ask)
  c.dispose() // ← adapter 的 finally
  let message = ''
  try { c.prepareInfer(ask) } catch (err) { message = String(err && err.message) }
  assert.match(message, /已 dispose/, '这才是 /status 里 intercepted>0 / forwarded==0 的成因')
})

await check('B2 shim 的模块能加载，并导出 startQoderShim', async () => {
  const mod = await import(pathToFileURL(SHIM).href)
  assert.equal(typeof mod.startQoderShim, 'function')
  for (const fn of ['askToOpenAiBody', 'applyCompressedBody', 'collectShimRegistrations', 'resolveQoderWasmPath']) {
    assert.equal(typeof mod[fn], 'function', fn + ' 应导出')
  }
})

await check('B2b 借出期间的 dispose 被推迟，release 后才真正释放', async () => {
  // 复刻 shim 的 dispose 包装语义，用真实 wasm 实例验证「推迟 → 重新加密 → 释放」这条链。
  // （不启动 shim 的 HTTP 服务：那需要宿主环境；这里只钉住补丁本身的行为。）
  const { QoderEncryptedInfer } = await import(pathToFileURL(HUB_WASM).href)
  const RELEASE_KEY = Symbol.for('mf.qoder.deferredRelease')
  const borrowed = new WeakSet()
  const original = QoderEncryptedInfer.prototype.dispose
  QoderEncryptedInfer.prototype.dispose = function (...args) {
    if (borrowed.has(this)) {
      this[RELEASE_KEY] = () => original.apply(this, args)
      return
    }
    return original.apply(this, args)
  }
  try {
    const opts = { user: { uid: 'u', securityOauthToken: 't' }, machineId: 'm', metadata: { a: 1 }, host: 'https://qoder.com/x' }
    const ask = { modelKey: 'dfmodel', userText: 'hi', history: [], tools: [], business: { type: 'agent' } }
    const c = await QoderEncryptedInfer.create(opts)
    borrowed.add(c)
    assert.ok(c.prepareInfer(ask).url.length > 0, '首次加密应成功')
    c.dispose() // adapter 的 finally
    assert.equal(c.disposed, false, '借出期间 dispose 必须被推迟')
    assert.ok(c.prepareInfer(ask).url.length > 0, '推迟生效后，shim 的重新加密应能成功')
    borrowed.delete(c)
    c[RELEASE_KEY]()
    assert.equal(c.disposed, true, 'release 后必须真正释放')
    let message = ''
    try { c.prepareInfer(ask) } catch (err) { message = String(err && err.message) }
    assert.match(message, /已 dispose/, '释放后不得再加密')
  } finally {
    QoderEncryptedInfer.prototype.dispose = original
  }
})

await check('B2c 同一条 rid 的 409 重发在宽限期内还能重新加密，宽限期过了才真正释放', async () => {
  // adapter 的 409 duplicate_request 分支会 continue 重发同一条加密请求，
  // 也就是同一个 rid 第二次打进来、复用同一个实例。立刻 free 会让那次重发撞上
  // 已释放的 context（wasm trap）。这里钉住「延后归还」的时序语义。
  const { QoderEncryptedInfer } = await import(pathToFileURL(HUB_WASM).href)
  const RELEASE_KEY = Symbol.for('mf.qoder.deferredRelease')
  const borrowed = new WeakSet()
  const original = QoderEncryptedInfer.prototype.dispose
  QoderEncryptedInfer.prototype.dispose = function (...args) {
    if (borrowed.has(this)) {
      this[RELEASE_KEY] = () => original.apply(this, args)
      return
    }
    return original.apply(this, args)
  }
  const release = (instance) => {
    borrowed.delete(instance)
    const deferred = instance[RELEASE_KEY]
    if (typeof deferred === 'function') deferred()
  }
  const releaseLater = (entry) => {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => { entry.timer = undefined; release(entry.self) }, 60)
  }
  try {
    const opts = { user: { uid: 'u', securityOauthToken: 't' }, machineId: 'm', metadata: { a: 1 }, host: 'https://qoder.com/x' }
    const ask = { modelKey: 'dfmodel', userText: 'hi', history: [], tools: [], business: { type: 'agent' } }
    const c = await QoderEncryptedInfer.create(opts)
    const entry = { self: c }
    borrowed.add(c)
    assert.ok(c.prepareInfer(ask).url.length > 0, '首次加密应成功')
    c.dispose() // adapter 的 finally，被推迟
    assert.ok(c.prepareInfer(ask).url.length > 0, '409 重发应能再次加密（context 还活着）')
    releaseLater(entry)
    assert.equal(c.disposed, false, '宽限期内不得释放')
    assert.ok(c.prepareInfer(ask).url.length > 0, '宽限期内再重发一次也应成功')
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    releaseLater(entry)
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(c.disposed, true, '宽限期过后必须真正释放')
    let message = ''
    try { c.prepareInfer(ask) } catch (err) { message = String(err && err.message) }
    assert.match(message, /已 dispose/, '释放之后不得再加密（否则重发会静默拿到坏请求）')
  } finally {
    QoderEncryptedInfer.prototype.dispose = original
  }
})

await check('B3 wrapCompressedBody 在原 ask 上保留协议字段，只换 messages/tools', async () => {
  const { applyCompressedBody } = await import(pathToFileURL(SHIM).href)
  const ask = {
    modelKey: 'dfmodel', systemText: 'SYS', history: [{ role: 'user', content: 'a' }],
    tools: [{ type: 'function', function: { name: 'x' } }], business: { type: 'agent' },
    isReasoning: true, displayName: 'DeepSeek-Flash', maxInputTokens: 1000000, maxTokens: 4096,
  }
  const body = {
    messages: [{ role: 'system', content: 'SYS2' }, { role: 'user', content: 'compressed' }],
    tools: [{ type: 'function', function: { name: 'y' } }], max_tokens: 1024,
  }
  const next = applyCompressedBody(ask, body)
  assert.equal(next.modelKey, 'dfmodel', 'modelKey 是协议字段，压缩不该动')
  assert.equal(next.business.type, 'agent', 'business 必填字段必须沿用')
  assert.equal(next.isReasoning, true)
  assert.equal(next.displayName, 'DeepSeek-Flash')
  assert.equal(next.maxInputTokens, 1000000)
  assert.equal(next.systemText, 'SYS2', '压缩后的 system 应替换原值')
  assert.equal(next.history.length, 1)
  assert.equal(next.history[0].content, 'compressed')
  assert.equal(next.tools[0].function.name, 'y')
  assert.equal(next.maxTokens, 1024)
})

await check('B4 applyCompressedBody 对不合法正文返回 null（调用方退回原 ask）', async () => {
  const { applyCompressedBody } = await import(pathToFileURL(SHIM).href)
  assert.equal(applyCompressedBody({ history: [] }, null), null)
  assert.equal(applyCompressedBody({ history: [] }, { messages: [] }), null)
  assert.equal(applyCompressedBody({ history: [] }, { messages: [{ content: 'x' }] }), null, '缺 role 应拒绝')
  assert.equal(applyCompressedBody({ history: [] }, { messages: [{ role: 'system', content: 'x' }] }), null, '只剩 system 应拒绝')
})

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过')
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.name + '：' + f.detail)
  process.exitCode = 1
}