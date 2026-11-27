/**
 * dsh-sidebar-scroller-compat — 浏览器半（手写 CJS-table bundle，与打包产物同格式）。
 *
 * 修什么：左侧栏「工作区 / 会话」列表整块空白，控制台报
 *     TypeError: useSectionScroller is not a function
 *     at WorkspaceBrowser (...)
 *     slot entry crashed in 'webnovel.workspaces'
 *
 * 为什么会这样（三方各自都合理，接起来才出事）：
 *   1. ui-sidebar 把 `sidebar.workspaces` 声明成带 hookContext 的槽：
 *      `hookContext: SidebarSectionHookContext` + `inject: SidebarSectionInjected`，
 *      其中 `inject.hooks.sectionScroller` 把 hookContext 里的 `useSectionScroller`
 *      变成占用者的 `useSectionScroller` prop。该契约由 PR #7337 / commit 63026c7a5c
 *      引入，随 dsh-v0.2.2-rc.2 首发。
 *   2. 因此**任何**占用 `sidebar.workspaces` 的条目都会收到真实的 `useSectionScroller`——
 *      包括第三方接管的组件。
 *   3. ui-workspace 的 `WorkspaceBrowser` 要求这个 prop，因为列表区自己就是纵向滚动容器
 *      （`const { bindScrollerRef } = useSectionScroller()`，见
 *      ui-workspace/src/client/rows/WorkspaceBrowser.tsx:1118）。
 *
 * 出事点：scriptor 8.4.0 接管 `sidebar.workspaces` 后，把官方条目克隆到自己的子槽
 * `webnovel.workspaces` 再渲染（`renderSlot('webnovel.workspaces', {wide, expandSidebar})`）。
 * 那个子槽由它自己声明，只有 `{kind:'single', scope:'root'}` —— 没有 hookContext，
 * 于是克隆出来的 `WorkspaceBrowser` 拿到 `useSectionScroller === undefined`，首屏即崩，
 * 错误边界把整块浏览区收成空白。
 *
 * 它缺的东西其实就在手上：接管组件本身**已经**收到了 `useSectionScroller`，
 * 只是在渲染子槽时没有继续往下传。本插件就在这一跳上补齐——把接管组件收到的
 * `useSectionScroller` 转发进它每一次子槽渲染的 owner props。
 *
 * 为什么这么做是安全的：
 *   * 只加一个 prop，不改任何插件的文件、不改 DSH、不降低鉴权或渲染约束；
 *   * 渲染器的 props 合成顺序是 `{...kit}{...injected}{...slotInjected.props}
 *     {...contextual}{...ownerProps}`（ui-renderer/src/client/scoped-slots.tsx:672），
 *     owner props 最后合并，所以转发值一定生效；
 *   * 不需要该子槽声明 hookContext：只有槽自己声明了 `inject.hooks` 才会走
 *     `bindSlotHookFactories`，否则直接作为普通 prop 透传（未声明的 prop 对不关心它的
 *     组件是无害的）；
 *   * 只包装「声明了子槽」的占用者：没有子槽就没有可转发的一跳，不碰。
 *
 * 稳定性要求：`entry.component` 必须**只换一次**。渲染器每帧读 `entry.component`
 * （scoped-slots.tsx 的 RootEntry），换新引用会让 React 卸载重挂整棵子树、丢掉
 * 滚动位置与内部状态，所以这里用 WeakSet 记住已包装的条目，包装器本身也按条目缓存。
 *
 * 生命周期：插件卸载时把每个条目的 component 还原成包装前的引用。
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-scroller-compat',
  factory: function factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    var LOG = '[dsh-sidebar-scroller-compat]'
    /** 被接管的槽：只有它的占用者会拿到 sectionScroller hook。 */
    var TARGET_SLOT = 'sidebar.workspaces'
    /** hookContext 工厂合成出来的 prop 名（sidebar 侧 `hooks.sectionScroller`）。 */
    var HOOK_PROP = 'useSectionScroller'
    /** 补齐用的优先级：远高于任何真实占用者，永远不是 single 槽的赢家。 */
    var NUDGE_PRIORITY = 1e6

    var React = null
    try {
      React = require('react')
    } catch (error) {
      console.warn(LOG, 'react unavailable, disabled:', error)
    }

    /** 已包装的条目 → 包装前的 component，卸载时据此还原。 */
    var patched = new WeakMap()
    /** 本次 apply 的卸载器集合。 */
    var teardowns = []

    /**
     * 给一个组件套上「把 useSectionScroller 转发进子槽渲染」的外壳。
     * @param Component - 接管组件（原样渲染，只改它收到的 renderSlot）。
     * @param label - 诊断用名称。
     * @returns 包装后的组件；组件不可调用时返回 undefined。
     */
    function wrap(Component, label) {
      if (typeof Component !== 'function') return undefined
      /**
       * @param props - 合成后的插槽 props，含 `useSectionScroller` 与 `renderSlot`。
       * @returns 原组件的元素树。
       */
      function SectionScrollerForwarder(props) {
        var useSectionScroller = props[HOOK_PROP]
        var renderSlot = props.renderSlot
        var forwarded = React.useMemo(function () {
          if (typeof renderSlot !== 'function' || typeof useSectionScroller !== 'function') return renderSlot
          /**
           * @param key - 子槽键。
           * @param owner - owner props（调用方给的）。
           * @param opts - 渲染选项（entryKey / only / fallback / hookContext）。
           * @returns 子槽内容。
           */
          return function renderSlotWithScroller(key, owner, opts) {
            var next = owner !== null && typeof owner === 'object'
              ? Object.assign({}, owner, { [HOOK_PROP]: useSectionScroller })
              : owner
            return renderSlot(key, next, opts)
          }
        }, [renderSlot, useSectionScroller])
        var next = Object.assign({}, props, { renderSlot: forwarded })
        return React.createElement(Component, next)
      }
      SectionScrollerForwarder.displayName = 'SectionScrollerForwarder(' + (label || 'occupant') + ')'
      return SectionScrollerForwarder
    }

    /**
     * 包装一个占用者条目（幂等）。
     * @param ctx - 客户端上下文。
     * @param entry - SlotRegistry 的注册条目。
     * @returns 本次是否真的换了组件。
     */
    function patchEntry(ctx, entry) {
      if (!entry || patched.has(entry)) return false
      // 没有子槽就没有可转发的一跳。
      if (!entry.children || Object.keys(entry.children).length === 0) return false
      var original = entry.component
      var label = entry.options && entry.options.id ? entry.options.id : 'occupant'
      var wrapped = wrap(original, label)
      if (wrapped === undefined) return false
      entry.component = wrapped
      patched.set(entry, original)
      return true
    }

    /**
     * 扫一遍目标槽的全部占用者。
     * @param ctx - 客户端上下文。
     * @returns 本次包装的条目数。
     */
    function scan(ctx) {
      var count = 0
      try {
        var entries = ctx.slots.entries(TARGET_SLOT)
        for (var i = 0; i < entries.length; i += 1) {
          if (patchEntry(ctx, entries[i])) count += 1
        }
      } catch (error) {
        console.warn(LOG, 'scan failed:', error)
      }
      return count
    }

    /**
     * 让渲染器为某个槽重新取一次数据。
     *
     * 注册表把 `markDirty` 设为私有，插件无法直接通知；这里落一次「注册 + 立刻注销」，
     * 两次变更都会 bump 版本并调度重渲染，净条目数为零。优先级取得足够高，
     * 所以这个临时条目永远不是 single 槽的赢家，渲染结果与没注册过一样。
     * @param ctx - 客户端上下文。
     */
    function nudge(ctx) {
      var off = null
      try {
        off = ctx.slots.register({ name: TARGET_SLOT, priority: NUDGE_PRIORITY }, function EmptyNudge() { return null })
      } catch (error) {
        // 单个槽在同优先级只允许一个占用者；1e6 已被占说明已有别人做过，无需再推。
        return
      }
      try {
        if (typeof off === 'function') off()
      } catch (error) {
        console.warn(LOG, 'nudge dispose failed:', error)
      }
    }

    /**
     * 挂载：先补当前已注册的占用者，再盯住后续的注册变化。
     * @param ctx - 客户端上下文。
     */
    function apply(ctx) {
      if (React === null) return
      try {
        var patchedNow = scan(ctx)
        // 本次 apply 时占用者已经在了，说明首帧可能已经渲染过（例如 HMR 重装）；
        // 推一次让渲染器重新取 component。首帧之前落库的情况推这一次也没有副作用。
        if (patchedNow > 0) nudge(ctx)

        // 注册表的公开订阅面（微任务批处理，与渲染器同一个 rAF 节奏）。
        teardowns.push(ctx.slots.subscribe(TARGET_SLOT, function targetChanged() {
          // 注册变化本身已经调度过重渲染，这里只补包装、不必再推。
          scan(ctx)
        }))

        teardowns.push(function restore() {
          var restored = 0
          try {
            var entries = ctx.slots.entries(TARGET_SLOT)
            for (var i = 0; i < entries.length; i += 1) {
              var entry = entries[i]
              var original = patched.get(entry)
              if (original === undefined) continue
              entry.component = original
              patched.delete(entry)
              restored += 1
            }
          } catch (error) {
            console.warn(LOG, 'restore failed:', error)
          }
          if (restored > 0) nudge(ctx)
        })

        console.info(LOG, 'active; forwards useSectionScroller into takeover child slots')
      } catch (error) {
        console.warn(LOG, 'apply failed:', error)
      }
    }

    /**
     * 手动收手：还原所有被包装的条目。幂等。
     */
    function dispose() {
      var pending = teardowns.slice().reverse()
      teardowns.length = 0
      for (var i = 0; i < pending.length; i += 1) {
        try {
          pending[i]()
        } catch (error) {
          console.warn(LOG, 'teardown failed:', error)
        }
      }
    }

    /**
     * 自检：说明当前目标槽有几个占用者、其中几个已被包装。
     * @param ctx - 客户端上下文（控制台调用可省略，省略时只报计数）。
     * @returns 诊断快照。
     */
    function diagnose(ctx) {
      var out = { occupants: 0, patched: 0 }
      try {
        if (ctx !== undefined && ctx !== null && ctx.slots) {
          var entries = ctx.slots.entries(TARGET_SLOT)
          out.occupants = entries.length
          for (var i = 0; i < entries.length; i += 1) {
            if (patched.has(entries[i])) out.patched += 1
          }
        }
      } catch (error) {
        out.error = String(error)
      }
      return out
    }

    exports.name = 'sidebar-scroller-compat'
    /** 等插槽注册表就绪再挂载。 */
    exports.inject = ['slots']
    exports.apply = apply
    exports.dispose = dispose
    exports.diagnose = diagnose

    try {
      window.dshSidebarScrollerCompat = exports
    } catch (error) {
      console.warn(LOG, 'cannot expose console handle:', error)
    }

    return exports
  },
})
