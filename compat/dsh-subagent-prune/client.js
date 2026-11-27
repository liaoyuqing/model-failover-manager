/**
 * dsh-subagent-prune — 浏览器半（手写 CJS-table bundle，与打包产物同格式）。
 *
 * 做什么：会话面板的「子智能体」分栏原本只能越攒越多——那份列表来自父会话日志里只增
 * 不减的 subagent/catalog 事件投影（subagentCatalog），宿主没有删除入口。本插件接管这个
 * 分栏，提供两个动作：
 *   · 每行的「×」：把这个子代理从列表里删除；
 *   · 标题旁的「清空」：把当前这一栏的子代理一次删除。
 *
 * 删除在三层生效：面板里不再列出；宿主半（host.mjs）在工具面上让会话里的模型也查不到它们
 * ——list_agents 的结果里没有这些条目，send_message 指向它们会被拒绝；被删子代理的当前执行
 * 被中断。删除可逆：宿主把「哪个父会话删除了哪些子代理」记在
 * <DSH_HOME>/dsh-subagent-prune/state.json，「恢复」把它们放回列表。
 *
 * 为什么接管而不是改 DSH：分栏由 ui-subagent 注册在 conversation.session.panel.section
 * （id 'subagents'，优先级 0）。动态插件注册时 guard 会分配一个负的页面局部优先级，
 * 同 id 的 list 单元格里排在内置条目前面，于是成为该单元格的赢家；若本条目崩溃，注册表
 * 会把它退役，内置分栏立刻回填——降级路径天然存在。
 */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-prune',
  factory: function factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    var LOG = '[dsh-subagent-prune]'
    var API = '/dsh-subagent-prune/api'
    var SECTION_SLOT = 'conversation.session.panel.section'
    var ACTIONS_SLOT = 'conversation.session.panel.section.actions'
    var SECTION_ID = 'subagents'
    var FOLD_LIMIT = 8

    var React = null
    try { React = require('react') } catch (error) { React = null }

    /* ------------------------------------------------------------ store -- */
    /** 删除集合：{ sessions: { [parentSessionId]: [childId] } }，接口与宿主 state.json 同形。 */
    var deletedState = { sessions: {} }
    var listeners = new Set()

    function emit() {
      listeners.forEach(function (fn) {
        try { fn() } catch (error) { console.warn(LOG, 'listener failed:', error) }
      })
    }

    function absorb(payload) {
      var sessions = payload && payload.sessions
      if (sessions === null || typeof sessions !== 'object') return false
      var next = {}
      Object.keys(sessions).forEach(function (sessionId) {
        var ids = sessions[sessionId]
        if (!Array.isArray(ids)) return
        var clean = ids.filter(function (id) { return typeof id === 'string' && id.length > 0 })
        if (clean.length > 0) next[sessionId] = clean
      })
      deletedState = { sessions: next }
      emit()
      return true
    }

    function deletedOf(sessionId) {
      var ids = deletedState.sessions[sessionId]
      return Array.isArray(ids) ? ids : []
    }

    function subscribe(listener) {
      listeners.add(listener)
      return function () { listeners.delete(listener) }
    }

    function getSnapshot() { return deletedState }

    function loadState() {
      return fetch(API + '/state', { credentials: 'same-origin' })
        .then(function (res) { return res.json() })
        .then(function (body) {
          if (body && body.ok !== false) absorb(body)
          else console.warn(LOG, 'state rejected:', body && body.error)
        })
        .catch(function (error) { console.warn(LOG, 'state load failed:', error) })
    }

    function postJson(path, body) {
      return fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.json().then(function (payload) {
          if (!res.ok || (payload && payload.ok === false)) {
            throw new Error((payload && payload.error) || ('HTTP ' + res.status))
          }
          absorb(payload)
          return payload
        })
      })
    }

    function deleteChildren(sessionId, childIds, deleted) {
      if (childIds.length === 0) return Promise.resolve()
      return postJson('/set', { sessionId: sessionId, childIds: childIds, hidden: deleted })
    }

    function restoreAll(sessionId) {
      return postJson('/reset', { sessionId: sessionId })
    }

    /* ------------------------------------------------------------ hooks -- */
    function useDeleted() {
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    /**
     * 读一棵子代理树：递归读每个子代理自己的目录，标出已删除的条目和运行状态。
     * @param projections - useSessions 选出的 projectionsBySession。
     * @param summaries - useSessions 选出的 byId。
     * @param statuses - useSessionStatus 快照。
     * @param deleted - 当前父会话的删除 id 集合。
     * @param sessionId - 目录根会话。
     * @param depth - 当前层级；根的直接子代理是 0。
     * @param out - 收集到的行。
     */
    function collectRows(projections, summaries, statuses, deleted, sessionId, depth, out) {
      var own = projections === undefined ? undefined : projections[sessionId]
      var catalog = own && own.values && own.values.subagentCatalog
      if (!Array.isArray(catalog)) return
      catalog.forEach(function (entry) {
        if (!entry || typeof entry.id !== 'string') return
        var status = statuses && statuses.get ? statuses.get(entry.id) : undefined
        var summary = summaries && summaries[entry.id]
        var running = (status && status.running) === true || (summary && summary.running) === true
        var isDeleted = deleted[entry.id] === true
        out.push({
          id: entry.id,
          label: entry.label || (summary && summary.displayTitle) || (summary && summary.title) || entry.name || entry.id.slice(0, 8),
          name: entry.name,
          mode: entry.mode,
          createdAt: entry.createdAt || 0,
          running: running,
          depth: depth,
          deleted: isDeleted,
          timing: summary !== undefined && summary !== null && summary.projectionValues !== undefined
            ? summary.projectionValues.subagentTiming
            : undefined,
        })
        // 已删除的条目不再展开：它的子代理随它一起消失，宿主半也按同一条规则过滤。
        if (!isDeleted) collectRows(projections, summaries, statuses, deleted, entry.id, depth + 1, out)
      })
    }

    /**
     * 读父会话的子代理树，并带上运行状态与删除标记。
     * @param projections - useSessions 选出的 projectionsBySession。
     * @param summaries - useSessions 选出的 byId。
     * @param statuses - useSessionStatus 快照。
     * @param deletedIds - 当前父会话的删除 id 列表。
     * @param sessionId - 分栏所属的父会话；只读它自己的目录，不把同工作区其它会话的子代理混进来。
     * @returns {Array<object>} 树形行，父在前、子在后。
     */
    function buildRows(projections, summaries, statuses, deletedIds, sessionId) {
      var deleted = {}
      ;(deletedIds || []).forEach(function (id) { deleted[id] = true })
      var rows = []
      collectRows(projections, summaries, statuses, deleted, sessionId, 0, rows)
      rows.sort(function (a, b) {
        return (b.running ? 1 : 0) - (a.running ? 1 : 0) || (b.createdAt - a.createdAt)
      })
      return rows
    }

    /**
     * 一个子代理的累计运行时长（毫秒）：计时投影给出已结算时长与当前开启区间。
     * 运行时长按当前时刻算，静止时按区间终点算。
     * @param row - 一行子代理。
     * @param now - 当前时刻（毫秒）。
     * @returns {number|undefined} 时长；没有计时投影时为 undefined。
     */
    function activityDurationMs(row, now) {
      var timing = row.timing
      if (timing === undefined || timing === null) return undefined
      var settled = typeof timing.settledMs === 'number' ? timing.settledMs : 0
      if (timing.active === undefined || timing.active === null) return settled
      var end = row.running ? now : timing.active.through
      return settled + Math.max(0, end - timing.active.since)
    }

    /**
     * 运行时长的显示文本，精度随量级递减。
     * @param ms - 时长（毫秒）。
     * @returns {string} 显示文本。
     */
    function formatDuration(ms) {
      var parts = splitDuration(ms)
      if (parts.days >= 30) {
        var months = Math.floor(parts.days / 30)
        var remainingDays = parts.days % 30
        return remainingDays === 0 ? ('约' + months + '个月') : ('约' + months + '个月' + remainingDays + '天')
      }
      if (parts.days > 0) {
        return parts.hours === 0 ? (parts.days + '天') : (parts.days + '天' + parts.hours + '小时')
      }
      if (parts.totalHours > 0) {
        return parts.totalHours + '小时' + pad2(parts.minutes) + '分' + pad2(parts.seconds) + '秒'
      }
      if (parts.totalMinutes > 0) {
        return parts.totalMinutes + '分' + pad2(parts.seconds) + '秒'
      }
      return parts.seconds + '秒'
    }

    /**
     * 保留整秒精度的时长文本，用在悬停标题上。
     * @param ms - 时长（毫秒）。
     * @returns {string} 显示文本。
     */
    function formatExactDuration(ms) {
      var parts = splitDuration(ms)
      if (parts.days === 0) return formatDuration(ms)
      return parts.days + '天' + pad2(parts.hours) + '小时' + pad2(parts.minutes) + '分' + pad2(parts.seconds) + '秒'
    }

    /**
     * 把整数补成两位。
     * @param value - 整数值。
     * @returns {string} 两位文本。
     */
    function pad2(value) {
      return value < 10 ? ('0' + value) : String(value)
    }

    /**
     * 把时长拆成秒、分、时、天。
     * @param ms - 时长（毫秒）。
     * @returns {object} 各单位数值。
     */
    function splitDuration(ms) {
      var totalSeconds = Math.floor(Math.max(0, ms) / 1000)
      var totalMinutes = Math.floor(totalSeconds / 60)
      var totalHours = Math.floor(totalMinutes / 60)
      return {
        seconds: totalSeconds % 60,
        minutes: totalMinutes % 60,
        hours: totalHours % 24,
        days: Math.floor(totalHours / 24),
        totalMinutes: totalMinutes,
        totalHours: totalHours,
      }
    }

    var S = {
      body: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '2px 0' },
      hint: { fontSize: '11px', opacity: 0.6, padding: '4px 8px', lineHeight: 1.5 },
      row: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 6px', borderRadius: '6px', cursor: 'pointer', minWidth: 0 },
      dot: { width: '6px', height: '6px', borderRadius: '50%', flex: 'none' },
      label: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' },
      meta: { flex: 'none', fontSize: '11px', opacity: 0.55, whiteSpace: 'nowrap' },
      kill: { flex: 'none', border: 'none', background: 'transparent', cursor: 'pointer', opacity: 0.55, fontSize: '13px', lineHeight: 1, padding: '0 3px', color: 'inherit' },
      more: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '11px', opacity: 0.7, padding: '4px 8px', textAlign: 'left', color: 'inherit' },
      bar: { display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 6px 4px' },
      action: { border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))', background: 'transparent', borderRadius: '999px', cursor: 'pointer', fontSize: '11px', padding: '1px 8px', color: 'inherit', opacity: 0.8 },
      error: { fontSize: '11px', color: '#d9534f', padding: '2px 8px' },
      duration: { flex: 'none', fontSize: '11px', opacity: 0.7, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
    }

    /**
     * 接管后的「子智能体」分栏：仍是那棵树，只是每行多一个删除按钮、标题旁多一个清空按钮。
     */
    function PruneSection(props) {
      var sessionId = props.sessionId
      var useSessions = props.useSessions
      var useSessionStatus = props.useSessionStatus
      var openChild = props.openChild
      var deletedStateNow = useDeleted()
      var deleted = deletedStateNow.sessions[sessionId] || []
      var projections = useSessions(function (state) { return state.projectionsBySession })
      var summaries = useSessions(function (state) { return state.byId })
      var statuses = useSessionStatus ? useSessionStatus(function (value) { return value }) : undefined
      var expandedRef = React.useRef(null)
      if (expandedRef.current === null) expandedRef.current = {}
      var expandedVersion = React.useState(0)
      var setExpandedVersion = expandedVersion[1]
      var expanded = expandedRef.current
      var [busy, setBusy] = React.useState(false)
      var [problem, setProblem] = React.useState('')

      var rows = React.useMemo(function () {
        return buildRows(projections, summaries, statuses, deleted, sessionId)
      }, [projections, summaries, statuses, deletedStateNow, sessionId])

      var visible = rows.filter(function (row) { return row.deleted !== true })
      var shown = expanded['all'] ? visible : visible.slice(0, FOLD_LIMIT)
      // 运行中的行每秒刷新一次时刻，让时长跟着走。
      var hasRunning = visible.some(function (row) { return row.running })
      var [now, setNow] = React.useState(function () { return Date.now() })
      React.useEffect(function () {
        if (!hasRunning) return
        var timer = setInterval(function () { setNow(Date.now()) }, 1000)
        return function () { clearInterval(timer) }
      }, [hasRunning])

      function forget(ids) {
        if (ids.length === 0) return
        setBusy(true)
        setProblem('')
        deleteChildren(sessionId, ids, true)
          .catch(function (error) { setProblem('删除失败：' + String((error && error.message) || error)) })
          .then(function () { setBusy(false) })
      }

      function clearAll() {
        forget(visible.map(function (row) { return row.id }))
      }

      function restoreDeleted() {
        setBusy(true)
        setProblem('')
        restoreAll(sessionId)
          .catch(function (error) { setProblem('恢复失败：' + String((error && error.message) || error)) })
          .then(function () { setBusy(false) })
      }

      function open(row) {
        if (!openChild || row.mode === 'external') return
        try {
          openChild({ parentSessionId: sessionId, childSessionId: row.id, mode: row.mode })
          if (props.dismissOverlay) props.dismissOverlay()
        } catch (error) { console.warn(LOG, 'open child failed:', error) }
      }

      // 目录已经没有任何条目、也没有删除记录时才整栏消失；只剩删除记录时仍要留着「恢复」。
      if (rows.length === 0 && deleted.length === 0 && problem === '') return null

      var children = []
      children.push(React.createElement('div', { key: 'bar', style: S.bar },
        React.createElement('button', {
          key: 'clear',
          type: 'button',
          style: S.action,
          disabled: busy || visible.length === 0,
          title: '把这个会话的子代理全部从列表删除（会话里的工具也查不到，可恢复）',
          onClick: clearAll,
        }, busy ? '处理中…' : '清空'),
        deleted.length > 0 && React.createElement('button', {
          key: 'restore',
          type: 'button',
          style: S.action,
          disabled: busy,
          title: '把删除的子代理放回列表',
          onClick: restoreDeleted,
        }, '恢复 ' + deleted.length + ' 个'),
        React.createElement('span', { key: 'count', style: S.meta }, visible.length + ' 个')))

      if (problem !== '') children.push(React.createElement('div', { key: 'err', style: S.error }, problem))

      children.push(React.createElement('div', { key: 'rows', style: S.body }, shown.map(function (row) {
        var rowStyle = Object.assign({}, S.row, row.depth > 0 ? { paddingLeft: 6 + row.depth * 12 + 'px' } : {})
        var durationMs = activityDurationMs(row, now)
        return React.createElement('div', {
          key: row.id,
          style: rowStyle,
          role: 'button',
          tabIndex: 0,
          title: durationMs === undefined ? row.label : (row.label + ' · 运行 ' + formatExactDuration(durationMs)),
          onClick: function () { open(row) },
          onKeyDown: function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              open(row)
            }
          },
        },
          React.createElement('span', {
            key: 'dot',
            style: Object.assign({}, S.dot, {
              background: row.running ? '#57ab5a' : 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.45))',
            }),
          }),
          React.createElement('span', { key: 'label', style: S.label }, row.label),
          React.createElement('span', { key: 'meta', style: S.meta }, row.mode === 'external' ? '外部' : (row.running ? '运行中' : '')),
          durationMs === undefined ? null : React.createElement('span', { key: 'duration', style: S.duration }, formatDuration(durationMs)),
          React.createElement('button', {
            key: 'kill',
            type: 'button',
            style: S.kill,
            title: '删除这个子代理（会话里的工具也查不到，可恢复）',
            'aria-label': '删除 ' + row.label,
            onClick: function (event) { event.preventDefault(); event.stopPropagation(); forget([row.id]) },
          }, '×'))
      })))

      if (visible.length > FOLD_LIMIT) {
        children.push(React.createElement('button', {
          key: 'more',
          type: 'button',
          style: S.more,
          onClick: function () {
            expanded['all'] = !expanded['all']
            setExpandedVersion(function (n) { return n + 1 })
          },
        }, expanded['all'] ? '收起' : ('显示其余 ' + (visible.length - FOLD_LIMIT) + ' 个')))
      }

      if (deleted.length > 0) {
        children.push(React.createElement('div', { key: 'deleted', style: S.hint }, '已删除 ' + deleted.length + ' 个'))
      }

      return React.createElement('div', { style: S.body, 'data-subagent-prune': '' }, children)
    }

    /** 标题右侧的动作位：可见/删除计数。 */
    function PruneActions(props) {
      var sessionId = props.sessionId
      var useSessions = props.useSessions
      var useSessionStatus = props.useSessionStatus
      var deletedStateNow = useDeleted()
      var deleted = deletedStateNow.sessions[sessionId] || []
      var projections = useSessions(function (state) { return state.projectionsBySession })
      var summaries = useSessions(function (state) { return state.byId })
      var statuses = useSessionStatus ? useSessionStatus(function (value) { return value }) : undefined
      var rows = React.useMemo(function () {
        return buildRows(projections, summaries, statuses, deleted, sessionId)
      }, [projections, summaries, statuses, deletedStateNow, sessionId])
      var visible = rows.filter(function (row) { return row.deleted !== true })
      if (visible.length === 0 && deleted.length === 0) return null
      var running = visible.filter(function (row) { return row.running }).length
      var text = running > 0 ? (running + ' 运行中') : (visible.length + ' 个')
      return React.createElement('span', { style: { fontSize: '11px', opacity: 0.65 } }, text)
    }

    /* --------------------------------------------------------- register -- */
    function apply(ctx) {
      if (React === null) return
      loadState()

      try {
        ctx.slots.inject(SECTION_SLOT, function () {
          return ctx.slots.register({
            name: SECTION_SLOT,
            id: SECTION_ID,
            // 低于内置注册的 0，才在同一 id 的 list 单元格里成为赢家。
            priority: -1,
            order: 200,
            label: '子智能体',
            // 内置分栏的 openChild 由 ui-subagent 经 inject 注入；这里自己给一份等价实现，
            // 否则行点击没有目标可跳。
            inject: function () {
              return {
                openChild: function (address) { ctx.uiWorkspace.openSession(address) },
              }
            },
          }, PruneSection)
        })
      } catch (error) { console.error(LOG, 'section registration failed', error) }

      try {
        ctx.slots.inject(ACTIONS_SLOT, function () {
          return ctx.slots.register({
            name: ACTIONS_SLOT,
            key: SECTION_ID,
            priority: -1,
          }, PruneActions)
        })
      } catch (error) { console.error(LOG, 'actions registration failed', error) }
    }

    exports.inject = ['slots', 'uiWorkspace']
    exports.apply = apply

    try {
      window.dshSubagentPrune = {
        state: getSnapshot,
        reload: loadState,
        deleteChildren: deleteChildren,
        restoreAll: restoreAll,
      }
    } catch (error) { console.warn(LOG, 'cannot expose console handle:', error) }

    return exports
  },
})
