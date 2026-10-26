/**
 * model-failover-manager — Client 浏览器半（DSH dynamic client bundle）。
 *
 * 1. 接管 composer 的模型选择位（conversation.input.model，priority -1 遮蔽原实现）：
 *    - 设置项 dialogMode 开启时，点击弹左右分区弹窗（左：提供商，右：模型）
 *    - 关闭时，紧凑下拉列表
 *    - 弹窗内含「路由分组」「数据看板」「失败模型」页签；分组可绑定到当前会话
 * 2. 设置页「模型故障转移」：dialogMode 开关 + 分组 CRUD（含优先级）+ 失败模型恢复
 * 3. 数据看板：读 /metrics 展示每个模型的首字延迟、输出速度、并发占用与排队，
 *    表头可点击排序；并发上限在这里按模型配置，对所有分组统一生效
 *
 * 数据来自 Host 半的 /api/model-failover 接口。
 */
window.__ModuleLoader__.load({
  id: 'model-failover-manager',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    // react-dom 是 baseline 平台模块；弹窗必须 portal 到 document.body，
    // 否则会被 composer 席位（position: sticky; z-index: 7）的层叠上下文困住，
    // 右侧栏等更高层级会盖住它。
    var ReactDOM = require('react-dom')
    var createPortal = ReactDOM.createPortal
    var e = React.createElement
    var API = '/api/model-failover'
    var VERSION = 'v7'

    /* ------------------------------------------------------------ styles -- */
    // 只用 ui-theme 已定义的 --dsw-alias-* token，不写硬编码兜底色：
    // 兜底色会在另一套主题下与宿主界面脱节（浅色主题上出现深色块）。
    var S = {
      trigger: {
        display: 'flex', alignItems: 'center', gap: '4px',
        minWidth: 0, maxWidth: 'min(360px, 45cqw)', height: '28px',
        padding: '0 4px 0 8px', border: 'none', borderRadius: 'var(--dsw-radius-sm)',
        outline: 'none', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '13px', lineHeight: '20px', cursor: 'pointer',
      },
      triggerName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // 供应商名：先于模型名被压缩，但设了 maxWidth 保证长名也不会把模型名挤没
      triggerProvider: {
        flexShrink: 1000, minWidth: 0, maxWidth: '132px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-caption)',
      },
      triggerSep: { flexShrink: 1000, color: 'var(--dsw-alias-label-dimmed)', userSelect: 'none' },
      triggerEffort: { flexShrink: 1000, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-caption)' },
      badge: {
        flex: '0 0 auto', fontSize: '10px', padding: '0 5px', lineHeight: '14px',
        borderRadius: '7px', background: 'var(--dsw-alias-state-business-tertiary)',
        color: 'var(--dsw-alias-state-business-primary)',
      },
      overlay: {
        position: 'fixed', inset: 0, zIndex: 1200, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--dsw-alias-bg-mask-1)',
        backdropFilter: 'var(--dsw-mask-blur)', WebkitBackdropFilter: 'var(--dsw-mask-blur)',
      },
      // 宽度给到 860：右栏在看板页签要放 6 列数值表，720 时模型名只剩 40px
      dialog: {
        display: 'flex', flexDirection: 'column', width: 'min(94vw, 860px)',
        height: 'min(84vh, 600px)', borderRadius: 'var(--dsw-radius-md)', overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        color: 'var(--dsw-alias-label-primary)',
      },
      dialogHead: {
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l2)',
      },
      dialogTitle: { fontSize: '13px', fontWeight: 600, flex: 1, color: 'var(--dsw-alias-label-primary)' },
      body: { display: 'flex', flex: 1, minHeight: 0 },
      left: {
        width: '184px', flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderRight: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
      },
      leftTitle: { padding: '8px 12px 4px', fontSize: '11px', color: 'var(--dsw-alias-label-caption)', letterSpacing: '.4px' },
      leftList: { flex: 1, overflowY: 'auto', padding: '0 6px 8px' },
      providerRow: {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px',
        borderRadius: 'var(--dsw-radius-sm)', fontSize: '13px', cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
      },
      providerActive: {
        background: 'var(--dsw-alias-state-business-tertiary)',
        color: 'var(--dsw-alias-state-business-primary)', fontWeight: 600,
      },
      count: { marginLeft: 'auto', fontSize: '10px', color: 'var(--dsw-alias-label-dimmed)' },
      right: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
      tabs: { display: 'flex', gap: '2px', padding: '6px 10px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      tab: {
        padding: '5px 12px', fontSize: '12px', border: 'none', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
        borderRadius: 'var(--dsw-radius-sm) var(--dsw-radius-sm) 0 0',
      },
      tabActive: { background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
      pane: { flex: 1, overflowY: 'auto', padding: '6px 10px 10px', minHeight: 0 },
      search: {
        width: '100%', boxSizing: 'border-box', margin: '6px 0',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-sm)', padding: '5px 9px', fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)', outline: 'none',
      },
      modelRow: {
        display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px',
        borderRadius: 'var(--dsw-radius-sm)', fontSize: '13px', cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
      },
      modelCurrent: {
        background: 'var(--dsw-alias-state-business-tertiary)',
        color: 'var(--dsw-alias-state-business-primary)', fontWeight: 600,
      },
      modelFailed: { opacity: .45, textDecoration: 'line-through', cursor: 'not-allowed' },
      tag: {
        fontSize: '10px', padding: '1px 6px', borderRadius: '4px',
        background: 'var(--dsw-alias-interactive-bg-hover-danger)',
        color: 'var(--dsw-alias-state-error-primary)',
        // 固定宽度列里必须能收窄，否则长标签会把整列挤宽
        maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', padding: '6px 2px' },
      btn: {
        padding: '3px 10px', fontSize: '11px', cursor: 'pointer',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-sm)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      btnPrimary: {
        padding: '3px 10px', fontSize: '11px', cursor: 'pointer', border: 'none',
        borderRadius: 'var(--dsw-radius-sm)', background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)', fontWeight: 600,
      },
      btnDanger: {
        padding: '3px 10px', fontSize: '11px', cursor: 'pointer',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-sm)', background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      groupCard: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)', padding: '8px 10px', marginBottom: '6px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      groupHead: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', flexWrap: 'wrap' },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 7px',
        margin: '2px 3px 2px 0', borderRadius: '4px', fontSize: '11px',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      chipFailed: { opacity: .5, textDecoration: 'line-through' },
      /** 用户显式禁用的模型块：不做删除线（那不是失败），只压暗 + 虚线边 */
      chipDisabled: {
        opacity: .55,
        borderStyle: 'dashed',
        textDecoration: 'none',
      },
      /** 模型块上的操作按钮（失败 / 禁用 / 恢复） */
      chipBtn: {
        background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer',
        fontSize: '10px', lineHeight: '14px', color: 'var(--dsw-alias-label-tertiary)',
        borderRadius: '3px',
      },
      chipBtnOn: { color: 'var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-primary))', fontWeight: 600 },
      modalBg: {
        position: 'fixed', inset: 0, zIndex: 1300, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--dsw-alias-bg-mask-1)',
        backdropFilter: 'var(--dsw-mask-blur)', WebkitBackdropFilter: 'var(--dsw-mask-blur)',
      },
      modal: {
        width: 'min(92vw, 560px)', maxHeight: '82vh', overflow: 'auto',
        borderRadius: 'var(--dsw-radius-md)', padding: '18px 20px',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
        boxShadow: 'var(--dsw-elevation-prominent)',
      },
      input: {
        width: '100%', boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-sm)', padding: '5px 9px', fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)', outline: 'none',
      },
      prio: {
        width: '46px', textAlign: 'center', background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: '4px', padding: '2px 4px', fontSize: '11px',
        color: 'var(--dsw-alias-label-primary)', outline: 'none',
      },
      row: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', color: 'var(--dsw-alias-label-primary)' },
      foot: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' },
      settingsRoot: { fontSize: '13px', lineHeight: 1.6, padding: '16px 20px 24px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)' },
      settingsTitle: { fontSize: '15px', fontWeight: 600, margin: '0 0 2px', color: 'var(--dsw-alias-label-primary)' },
      settingsSub: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', margin: '0 0 12px' },
      toggleRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', marginBottom: '14px' },
      toggle: {
        boxSizing: 'border-box', width: '36px', height: '20px', borderRadius: '999px',
        border: 'none', cursor: 'pointer', padding: '2px', position: 'relative',
        background: 'var(--dsw-alias-border-l3)', flexShrink: 0,
      },
      toggleOn: { background: 'var(--dsw-alias-brand-primary)' },
      toggleKnob: {
        display: 'block', width: '16px', height: '16px', borderRadius: '50%',
        background: 'var(--dsw-alias-switch-thumb)', transition: 'transform 120ms ease',
      },
      toggleKnobOn: { transform: 'translateX(16px)', background: 'var(--dsw-alias-label-primary-foreground)' },
      addBtn: {
        flex: '0 0 auto', width: '20px', height: '20px', lineHeight: '18px', textAlign: 'center',
        padding: 0, fontSize: '13px', cursor: 'pointer',
        border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: '4px',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
      },
      /** 模型行上的「所属分组」徽标：数量可能多，需要截断 */
      groupTag: {
        flex: '0 1 auto', minWidth: 0, maxWidth: '140px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontSize: '10px', lineHeight: '15px', padding: '0 6px', borderRadius: '4px',
        background: 'var(--dsw-alias-state-business-tertiary)',
        color: 'var(--dsw-alias-state-business-primary)',
      },
      /** 模型行上的并发上限输入：贴着分组徽标，只对已入组的模型显示 */
      modelConcWrap: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '3px' },
      // 宽 62px：34px 时数字输入框自带的上下箭头要吃掉约 14px，文本区只剩十几像素，
      // 两位以上的数都显示不全。这里留出 3 位数 + 箭头的余量。
      modelConcInput: {
        width: '62px', textAlign: 'center', boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: '4px', padding: '1px 2px', fontSize: '11px',
        color: 'var(--dsw-alias-label-primary)', outline: 'none',
        fontVariantNumeric: 'tabular-nums',
      },
      modelConcLabel: { fontSize: '10px', opacity: .55, whiteSpace: 'nowrap' },
      addMenu: {
        margin: '2px 0 6px 12px', padding: '4px 6px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-bg-layer-3)',
      },
      addMenuItem: {
        padding: '4px 6px', fontSize: '12px', cursor: 'pointer', borderRadius: '4px',
        color: 'var(--dsw-alias-label-primary)',
      },
      groupBar: {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 0 6px',
      },
      groupBarLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-caption)', flexShrink: 0 },
      select: {
        flex: 1, minWidth: 0, boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-sm)', padding: '4px 8px', fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)', outline: 'none', cursor: 'pointer',
      },
      /* ---- 数据看板：div 网格表格（本文件不引入任何表格库） ---- */
      metricsHead: {
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        padding: '2px 0 8px',
      },
      metricsNote: {
        fontSize: '11px', lineHeight: '1.6', color: 'var(--dsw-alias-label-tertiary)',
        padding: '0 2px 8px',
      },
      /** 日期筛选条：日期输入 + 快捷区间 */
      metricsFilter: {
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        padding: '0 2px 8px',
      },
      metricsDate: {
        boxSizing: 'border-box', flex: '0 0 auto',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-sm)', padding: '2px 6px', fontSize: '11px',
        color: 'var(--dsw-alias-label-primary)', outline: 'none',
      },
      metricsTable: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)', overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      // 模型列拿掉 nowrap：provider/model 太长时折行而不是被省略号吃掉
      // 六列：模型 / 首字 / 速度 / token / 并发 / 状态。状态列固定宽，否则「当日失败 +
      // 错误码」会把 auto 列撑宽、把模型列从 308px 压到 248px，整张表看着就乱了。
      // token 列比速度列宽一点：它要放「1.2K / 8.4K」这种两个数。
      metricsRow: {
        display: 'grid',
        gridTemplateColumns: 'minmax(120px, 1fr) 66px 82px 96px 76px 92px',
        alignItems: 'center', gap: '8px', padding: '6px 10px',
        borderTop: '0.5px solid var(--dsw-alias-border-l1)',
        fontSize: '12px', color: 'var(--dsw-alias-label-primary)',
      },
      metricsRowHead: {
        borderTop: 'none',
        fontSize: '10px', letterSpacing: '.3px',
        color: 'var(--dsw-alias-label-caption)',
        background: 'var(--dsw-alias-bg-layer-3)',
      },
      // 行级压暗要留住编辑能力：并发列是输入框，压太狠会看着像禁用
      metricsRowFailed: { opacity: .6 },
      metricsRowDisabled: { opacity: .7 },
      metricsCell: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // 数值列的两行写法：主值 + 淡色副值（P90、样本、等槽）。并成一列是为了
      // 让出宽度给模型名——两行文本比两列数字窄得多。
      metricsNumCell: {
        minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        gap: '1px', lineHeight: '1.3',
      },
      metricsNumMain: {
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
      },
      metricsNumSub: {
        fontSize: '10px', opacity: .55, fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
      },
      // 模型名：允许折行（break-word 兜住没有空格的长 id）
      metricsCellModel: { minWidth: 0, whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: '1.35' },
      metricsTagCell: {
        minWidth: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'flex-start', gap: '1px', lineHeight: '1.3',
      },
      metricsModel: { fontWeight: 600 },
      metricsSub: { fontSize: '10px', opacity: .6, marginTop: '1px', whiteSpace: 'normal', wordBreak: 'break-word' },
      // 表头按钮：整格可点，▲/▼ 指示当前排序列与方向
      metricsSortBtn: {
        background: 'none', border: 'none', padding: 0, margin: 0, font: 'inherit',
        color: 'inherit', cursor: 'pointer', minWidth: 0, textAlign: 'left',
        display: 'flex', alignItems: 'center', gap: '2px', overflow: 'hidden',
      },
      metricsSortBtnNum: { justifyContent: 'flex-end' },
      metricsSortBtnOn: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
      metricsSortMark: { fontSize: '9px', lineHeight: 1, flexShrink: 0 },
      // 并发列：显式配置输入框 + 生效上限
    }

    /* ----------------------------------------------------------- helpers -- */
    var statusCache = null
    /** apply() 里注入的 client ctx，供目录 RPC 使用 */
    var runtimeCtx = null
    /** 全量模型目录缓存：[{ provider, model, name, providerName }] */
    var catalogCache = null
    var catalogPending = null

    function loadStatus() {
      return fetch(API + '/status', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (d) { statusCache = d; return d })
        .catch(function () { return null })
    }

    /**
     * 拉取会话可用的完整模型目录（与内置模型选择器同源）。
     * Host 的 /status.allModels 只是「已在分组里的模型并集」，不能当可选池。
     */
    function loadCatalog() {
      if (catalogCache) return Promise.resolve(catalogCache)
      if (catalogPending) return catalogPending
      var session = runtimeCtx && runtimeCtx.remote && runtimeCtx.remote.session
      if (!session || typeof session.modelCatalog !== 'function') return Promise.resolve(null)
      catalogPending = session.modelCatalog().then(function (res) {
        if (!res || !res.ok) return null
        var flat = []
        var groups = (res.value && res.value.groups) || []
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i]
          var ms = g.models || []
          for (var j = 0; j < ms.length; j++) {
            var m = ms[j]
            flat.push({
              provider: g.id,
              model: m.id,
              name: m.name || m.id,
              providerName: g.name || g.id,
              // 思考强度候选（含默认值）；无 reasoning 的模型为 null
              efforts: (m.reasoning && m.reasoning.efforts) || null,
              defaultEffort: (m.reasoning && m.reasoning.defaultEffort) || null,
              failed: false,
            })
          }
        }
        catalogCache = flat
        return flat
      }).catch(function () { return null }).then(function (v) {
        catalogPending = null
        return v
      })
      return catalogPending
    }

    function apiSend(path, method, body) {
      return fetch(path, {
        method: method, credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json() })
    }
    function apiGet(path) {
      return fetch(path, { credentials: 'same-origin' }).then(function (r) { return r.json() })
    }
    function providerName(group) {
      return group.id === 'deepseek-account' ? 'DeepSeek 账号' : (group.name || group.id)
    }
    function keyOf(provider, model) { return provider + '/' + model }
    /**
     * 日界线文案：Host 的 failResetHour 决定「当日失败」几点重置（北京时间）。
     * Host 未返回该字段时（旧版）不提具体时间，只说按日重置——写死 8 点会
     * 与实际行为不符。
     */
    function dayBoundaryText(status) {
      var h = status && typeof status.failResetHour === 'number' ? status.failResetHour : null
      return h === null ? '每天自动重置' : '每天北京时间 ' + h + ':00 自动重置'
    }

    /* ------------------------------------------------------ 看板格式化 -- */
    // 看板接口（GET /metrics）拿到的都是「可能为 null」的聚合值：
    // 没样本时所有分位数为 null，concurrency 为 null 表示不限并发。
    function isNum(v) { return typeof v === 'number' && isFinite(v) }
    function fmtMs(v) { return isNum(v) ? Math.round(v) + 'ms' : '—' }
    function fmtTps(v) { return isNum(v) ? (Math.round(v * 10) / 10).toFixed(1) + ' tok/s' : '—' }
    function fmtConcLimit(v) { return Number.isInteger(v) && v > 0 ? String(v) : '不限' }
    /** 压缩计数写法：1234 → 1.2K，1234567 → 1.2M；保留一位小数，够看板比对用量 */
    function fmtTokens(v) {
      if (!isNum(v)) return '—'
      if (v < 1000) return String(Math.round(v))
      if (v < 1e6) return (Math.round(v / 100) / 10).toFixed(1) + 'K'
      return (Math.round(v / 1e5) / 10).toFixed(1) + 'M'
    }
    /** 合法的并发上限：正整数；其余（空、0、非整数）都表示「没配，跟随默认」 */
    function validConc(v) {
      var n = Math.floor(Number(v))
      return isFinite(n) && n >= 1 ? n : null
    }

    /**
     * 拉看板数据。
     * @param {{since?: string, until?: string}} [range] - YYYY-MM-DD，按北京时间整天；
     *   省略即全部保留的样本。筛选在 Host 侧做——缓冲区只有最近 N 条，界面拿不到被裁掉的。
     */
    function loadMetrics(range) {
      var qs = ''
      if (range && (range.since || range.until)) {
        var p = []
        if (range.since) p.push('since=' + encodeURIComponent(range.since))
        if (range.until) p.push('until=' + encodeURIComponent(range.until))
        qs = '?' + p.join('&')
      }
      return fetch(API + '/metrics' + qs, { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.json() })
        .catch(function () { return null })
    }

    /** 北京时间「今天」的 YYYY-MM-DD，与 Host 的日期筛选口径一致 */
    function beijingToday() {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date())
    }

    /** 往前推 n 天的北京时间日期（供快捷区间用） */
    function beijingDaysAgo(n) {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(Date.now() - n * 86_400_000))
    }

    /**
     * 可选模型池：优先用完整模型目录（与内置选择器同源），
     * 目录不可用时回落到 status.allModels；失败标记取自 status.failed。
     * 注意：status.allModels 只是「已在分组里的模型并集」，不能单独当可选池。
     */
    function poolOf(catalog, status) {
      var failedMap = {}
      ;((status && status.failed) || []).forEach(function (f) { failedMap[keyOf(f.provider, f.model)] = true })
      var base = (catalog && catalog.length) ? catalog : ((status && status.allModels) || [])
      return base.map(function (m) {
        return Object.assign({}, m, { failed: failedMap[keyOf(m.provider, m.model)] === true })
      })
    }

    /* =================================================== 模型选择位组件 == */
    function ModelSeat(props) {
      var snapPair = React.useState(null); var snap = snapPair[0]; var setSnap = snapPair[1]
      var uiPair = React.useState(false); var open = uiPair[0]; var setOpen = uiPair[1]
      var tabPair = React.useState('models'); var tab = tabPair[0]; var setTab = tabPair[1]
      var provPair = React.useState(null); var provider = provPair[0]; var setProvider = provPair[1]
      var qPair = React.useState(''); var query = qPair[0]; var setQuery = qPair[1]
      var stPair = React.useState(statusCache); var status = stPair[0]; var setStatus = stPair[1]
      var editPair = React.useState(null); var editing = editPair[0]; var setEditing = editPair[1]
      var openFailPair = React.useState({}); var openFailures = openFailPair[0]; var setOpenFailures = openFailPair[1]
      var addPair = React.useState(null); var addMenu = addPair[0]; var setAddMenu = addPair[1]
      var catPair = React.useState(catalogCache); var catalog = catPair[0]; var setCatalog = catPair[1]
      // 子代理会话：有效分组与当前模型由 Host 算出（继承父会话），本地拿不到
      var infoPair = React.useState(null); var subInfo = infoPair[0]; var setSubInfo = infoPair[1]
      /** 数据看板：GET /metrics 的结果；只在看板页签可见时才轮询 */
      var metPair = React.useState(null); var metrics = metPair[0]; var setMetrics = metPair[1]
      /** 看板排序：{ key, dir }；null = 默认序（分组名 → 优先级 → provider/model） */
      var sortPair = React.useState(null); var sort = sortPair[0]; var setSort = sortPair[1]
      /** 看板日期筛选：{ since, until } 均为 YYYY-MM-DD（北京时间整天）；空串 = 不限 */
      var rangePair = React.useState({ since: '', until: '' })
      var range = rangePair[0]; var setRange = rangePair[1]
      /** 并发输入框的本地草稿（按模型 key），避免每敲一个字符就被轮询回写覆盖 */
      var concPair = React.useState({}); var concDraft = concPair[0]; var setConcDraft = concPair[1]

      /** 默认并发上限：status.defaultConcurrency 是分组级默认，null = 未配置 */
      var defaultConc = status && typeof status.defaultConcurrency === 'number' ? status.defaultConcurrency : null
      var defaultConcHint = defaultConc === null ? '' : (defaultConc === 0 ? '当前默认不限' : '当前默认 ' + defaultConc)
      /** 输入框占位：显示“跟随”的默认值，让留空和写死都一眼可辨 */
      function defaultConcText() { return defaultConc === 0 ? '不限' : (defaultConc === null ? '' : String(defaultConc)) }

      /** 某模型的显式并发配置；0/缺省视为未配置，返回 null */
      function explicitConcOf(provider, model) {
        var map = (status && status.modelConcurrency) || {}
        var v = map[keyOf(provider, model)]
        return Number.isInteger(v) && v > 0 ? v : null
      }

      React.useEffect(function () {
        function sync() { setSnap(props.store.getSnapshot()) }
        sync()
        props.load()
        var off = props.store.subscribe(sync)
        loadStatus().then(function (d) { if (d) setStatus(d) })
        return off
      }, [])

      React.useEffect(function () {
        if (!open) return
        loadStatus().then(function (d) { if (d) setStatus(d) })
        // 打开弹窗即拉取完整模型目录（可选模型池）
        loadCatalog().then(function (c) { if (c) setCatalog(c) })
      }, [open, tab])

      // 子代理会话的有效分组/当前模型由 Host 解析（继承父会话），这里按需取回
      React.useEffect(function () {
        if (!props.subagent) { setSubInfo(null); return }
        apiGet(API + '/session-info?sessionId=' + encodeURIComponent(props.sessionId))
          .then(function (d) { if (d && d.ok) setSubInfo(d) })
          .catch(function () { })
      }, [props.sessionId, props.subagent, status, open])

      // 数据看板：弹窗打开且停在看板页签时每 3 秒拉一次 metrics；离开即停。
      // 依赖 [open, tab, range] 保证其它页签不会额外轮询，改日期范围立即重取。
      React.useEffect(function () {
        if (!open || tab !== 'dashboard') return
        function tick() { loadMetrics(range).then(function (d) { if (d) setMetrics(d) }) }
        tick()
        var t = setInterval(tick, 3000)
        return function () { clearInterval(t) }
      }, [open, tab, range])

      if (!props.available) return null
      // 内置模型目录对有归属的子代理会话不给快照；子代理位改用 Host 的
      // /session-info + status 渲染，这里给一个空壳顶住后续对 snap 的读取。
      if (!snap) {
        if (!props.subagent) return null
        snap = { groups: [], current: null, status: 'ready' }
      }

      var groups = (snap.groups || []).slice().sort(function (a, b) {
        var rank = function (g) { return g.id === 'deepseek-account' ? 0 : g.id === 'deepseek-official' ? 1 : 2 }
        return rank(a) - rank(b)
      })
      var dialogMode = !!(status && status.settings && status.settings.dialogMode)
      var current = snap.current
      var binding = null
      var bindingMode = 'route'
      if (props.subagent) {
        // 子代理：分组继承自父会话，当前模型看 Host 的覆盖值；
        // 覆盖还没建立时回落到会话自身的 provider/model 选项。
        if (subInfo) {
          var effB = subInfo.effectiveBinding
          if (effB) { binding = effB.groupId; bindingMode = effB.mode || 'route' }
          var ownSel = subInfo.override || subInfo.agentModel
          if (ownSel && ownSel.provider && ownSel.model) current = { provider: ownSel.provider, model: ownSel.model }
        }
      } else if (status && status.sessionGroups) {
        for (var i = 0; i < status.sessionGroups.length; i++) {
          if (String(status.sessionGroups[i].sessionId) === String(props.sessionId)) { binding = status.sessionGroups[i].groupId; bindingMode = status.sessionGroups[i].mode || 'route'; break }
        }
      }
      var currentKey = current ? keyOf(current.provider, current.model) : null
      var currentGroup = current ? groups.find(function (g) { return g.id === current.provider }) : undefined
      var currentModel = currentGroup ? currentGroup.models.find(function (m) { return m.id === current.model }) : undefined

      var failedMap = {}
      var failedList = (status && status.failed) || []
      failedList.forEach(function (f) { failedMap[keyOf(f.provider, f.model)] = true })
      var routeGroups = (status && status.groups) || []
      var boundGroup = binding ? routeGroups.find(function (g) { return g.id === binding }) : undefined
      // 默认分组：新会话自动沿用；null = 用户从未选过（不给新会话硬塞分组）
      var defaultBinding = (status && status.defaultBinding) || null
      var isDefault = !props.subagent && !!(binding && defaultBinding && defaultBinding.groupId === binding
        && (defaultBinding.mode || 'route') === bindingMode)

      /** 子代理重新取一次 Host 解析结果（继承分组 + 当前覆盖模型） */
      function refreshInfo() {
        if (!props.subagent) return
        apiGet(API + '/session-info?sessionId=' + encodeURIComponent(props.sessionId))
          .then(function (d) { if (d && d.ok) setSubInfo(d) })
          .catch(function () { })
      }

      function choose(providerId, modelId, reasoningEffort) {
        var selection = { provider: providerId, model: modelId }
        if (reasoningEffort !== undefined) selection.reasoningEffort = reasoningEffort
        Promise.resolve(props.select(selection)).then(refreshInfo, refreshInfo)
        setOpen(false)
      }
      function bindGroup(groupId, mode) {
        var body = { sessionId: props.sessionId, groupId: groupId }
        if (groupId) body.mode = mode || 'route'
        // 子代理的绑定只作用于它自己，不参与「新会话默认分组」
        if (props.subagent) body.asDefault = false
        apiSend(API + '/session-group', 'POST', body)
          .then(function (r) {
            // route 模式绑定后 Host 已把会话切到组内模型；同步 UI 选择
            if (r && r.ok && r.model) {
              return Promise.resolve(props.select({ provider: r.model.provider, model: r.model.model, ...(r.model.effort ? { reasoningEffort: r.model.effort } : {}) }))
                .then(function () { return loadStatus() })
            }
            return loadStatus()
          })
          .then(function (d) { if (d) setStatus(d) })
          .then(refreshInfo)
      }
      /** 把一个模型快捷加入分组（已存在则忽略） */
      function addToGroup(groupId, providerId, modelId) {
        var g = routeGroups.find(function (x) { return x.id === groupId })
        if (!g) return
        var exists = (g.models || []).some(function (m) { return m.provider === providerId && m.model === modelId })
        if (exists) { setAddMenu(null); return }
        var models = (g.models || []).concat([{ provider: providerId, model: modelId, priority: 99 }])
        apiSend(API + '/groups', 'PUT', { id: groupId, models: models })
          .then(function () { setAddMenu(null); refreshStatus() })
      }
      function reenable(providerId, modelId) {
        apiSend(API + '/failed/reset', 'POST', { provider: providerId, model: modelId })
          .then(function () { return loadStatus() })
          .then(function (d) { if (d) setStatus(d) })
      }
      function refreshStatus() { loadStatus().then(function (d) { if (d) setStatus(d) }) }

      var label = current
        ? (currentModel ? currentModel.name : current.model)
        : (snap.status === 'loading' ? '正在加载模型…' : '请选择模型')
      // 当前使用模型的供应商显示名；目录里查不到时回落到 provider id
      var providerLabel = current ? (currentGroup ? providerName(currentGroup) : current.provider) : null
      var effortLabel = current
        ? (current.reasoningEffort || (currentModel && currentModel.reasoning && currentModel.reasoning.defaultEffort))
        : undefined
      var triggerText = (providerLabel ? providerLabel + ' · ' : '') + (effortLabel ? label + ' · ' + effortLabel : label)

      function visibleGroups() {
        var needle = query.trim().toLowerCase()
        return groups.map(function (g) {
          var models = needle
            ? g.models.filter(function (m) { return (m.name || m.id).toLowerCase().indexOf(needle) >= 0 })
            : g.models
          return { id: g.id, name: g.name, models: models }
        }).filter(function (g) { return g.models.length > 0 })
      }

      /**
       * 该模型当前所属的分组列表（同一模型可同时属于多个分组）。
       * 数据来自 Host status.sessionGroups 之外的 groups[].models，无需额外请求。
       */
      function groupsOf(providerId, modelId) {
        var out = []
        for (var i = 0; i < routeGroups.length; i++) {
          var g = routeGroups[i]
          var hit = (g.models || []).some(function (x) { return x.provider === providerId && x.model === modelId })
          if (hit) out.push(g)
        }
        return out
      }

      function modelRows(providerGroup) {
        var out = []
        providerGroup.models.forEach(function (m) {
          var k = keyOf(providerGroup.id, m.id)
          var failed = failedMap[k] === true
          var isCurrent = currentKey === k
          var style = Object.assign({}, S.modelRow, isCurrent ? S.modelCurrent : {}, failed ? S.modelFailed : {})
          var inGroups = groupsOf(providerGroup.id, m.id)
          out.push(e('div', { key: m.id },
            e('div', {
              style: style, title: m.name,
              onClick: function () { if (!failed && !props.locked) choose(providerGroup.id, m.id, m.reasoning && m.reasoning.defaultEffort) },
              onMouseEnter: function (ev) { if (!isCurrent && !failed) ev.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' },
              onMouseLeave: function (ev) { if (!isCurrent && !failed) ev.currentTarget.style.background = '' },
            },
              e('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, m.name || m.id),
              failed && e('span', { style: S.tag }, '当日失败'),
              isCurrent && e('span', { style: { fontSize: '11px', opacity: .6 } }, '当前'),
              // 所属分组徽标：一眼看出该模型当前在哪些分组里
              inGroups.length > 0 && e('span', {
                style: S.groupTag,
                title: '所属分组：' + inGroups.map(function (g) { return g.name }).join('、'),
              }, inGroups.map(function (g) { return g.name }).join('、')),
              // 并发上限：只对已进分组的模型有意义（分组才是路由单位）。
              // 空 = 跟随默认上限；写数字 = 该模型显式上限，对所有分组统一生效。
              inGroups.length > 0 && e('span', {
                style: S.modelConcWrap,
                title: '该模型同时最多几个请求，对所有分组统一生效；留空 = 跟随默认上限'
                  + (defaultConcHint ? '（' + defaultConcHint + '）' : '')
                  + '。达到上限时会先尝试切到组内其它空闲模型，都满才排队。',
                onClick: function (ev) { ev.stopPropagation() },
              },
                e('span', { style: S.modelConcLabel }, '并发'),
                e('input', {
                  type: 'number', min: '1', max: '999',
                  style: S.modelConcInput,
                  value: concDraft[k] !== undefined
                    ? concDraft[k]
                    : (explicitConcOf(providerGroup.id, m.id) === null ? '' : String(explicitConcOf(providerGroup.id, m.id))),
                  placeholder: defaultConcText(),
                  'aria-label': '并发上限',
                  onChange: function (ev) { commitConcurrency(providerGroup.id, m.id, ev.target.value) },
                  onBlur: function () {
                    // 失焦即放弃本地草稿，输入框回到服务端记录的真实值
                    var nxt = Object.assign({}, concDraft)
                    delete nxt[k]
                    setConcDraft(nxt)
                  },
                })),
              // 快捷加入分组
              e('button', {
                style: S.addBtn, title: '加入路由分组',
                onClick: function (ev) { ev.stopPropagation(); setAddMenu(addMenu === k ? null : k) },
              }, '＋')),
            addMenu === k && e('div', { style: S.addMenu },
              routeGroups.length === 0 && e('div', { style: S.hint }, '还没有分组，先创建一个：'),
              routeGroups.map(function (g) {
                var inGroup = (g.models || []).some(function (x) { return x.provider === providerGroup.id && x.model === m.id })
                return e('div', {
                  key: g.id,
                  style: Object.assign({}, S.addMenuItem, inGroup ? { color: 'var(--dsw-alias-label-dimmed)' } : {}),
                  onClick: function () { if (!inGroup) addToGroup(g.id, providerGroup.id, m.id) },
                }, (inGroup ? '✓ ' : '') + g.name + '（' + (g.models || []).length + ' 个模型）')
              }),
              e('div', {
                style: S.addMenuItem,
                onClick: function () {
                  setAddMenu(null)
                  setEditing({ action: 'new', name: '', models: [{ provider: providerGroup.id, model: m.id, priority: 99 }] })
                },
              }, '＋ 新建分组并加入该模型'))))
        })
        return out
      }

      function effortRow() {
        if (!current || !currentModel || !currentModel.reasoning || !currentModel.reasoning.efforts) return null
        var levels = currentModel.reasoning.efforts
        var active = current.reasoningEffort || currentModel.reasoning.defaultEffort
        return e('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', padding: '4px 2px' } },
          e('span', { style: { fontSize: '11px', opacity: .6 } }, '推理等级'),
          levels.map(function (lv) {
            return e('button', {
              key: lv.id, style: lv.id === active ? S.btnPrimary : S.btn,
              onClick: function () { choose(current.provider, current.model, lv.id) },
            }, lv.name)
          }))
      }

      /* ---- 分组页签 ---- */
      function groupTab() {
        var avail = poolOf(catalog, status)
        return e('div', { style: S.pane },
          e('div', { style: S.hint }, '会话绑定分组后，本会话的每次请求都按组内优先级（数字越小越优先）选模型；彻底失败会自动跳到下一个可用模型。'),
          e('button', { style: Object.assign({}, S.btnPrimary, { marginBottom: '8px' }), onClick: function () { setEditing({ action: 'new', name: '', models: [] }) } }, '＋ 新建分组'),
          routeGroups.length === 0 && e('div', { style: S.hint }, '还没有分组。'),
          routeGroups.map(function (g) {
            var isBound = binding === g.id
            var sorted = (g.models || []).slice().sort(function (a, b) { return (a.priority ?? 99) - (b.priority ?? 99) })
            return e('div', { key: g.id, style: S.groupCard },
              e('div', { style: S.groupHead },
                e('span', { style: { fontWeight: 600, fontSize: '13px' } }, g.name),
                e('span', { style: { fontSize: '11px', opacity: .5 } }, g.models.length + ' 个模型'),
                isBound && e('span', { style: S.badge }, '本会话已绑定'),
                e('span', { style: { marginLeft: 'auto', display: 'flex', gap: '4px' } },
                  isBound
                    ? e('button', { style: S.btn, onClick: function () { bindGroup(null) } }, '解除绑定')
                    : e('button', { style: S.btnPrimary, onClick: function () { bindGroup(g.id) } }, '绑定到本会话'),
                  e('button', { style: S.btn, onClick: function () { setEditing({ action: 'edit', id: g.id, name: g.name, models: (g.models || []).slice() }) } }, '编辑'))),
              e('div', null, sorted.map(function (m) {
                var k = keyOf(m.provider, m.model)
                var f = failedMap[k] === true
                var off = m.disabled === true
                // 并发冷却：Host 因并发打满把它挡了几十秒，到期自动恢复。与「失败/禁用」
                // 三者互不覆盖——冷却中的模型并没有坏，不该被执行线划掉。
                var cd = m.capacityCooldown || null
                var cdLeft = cd && typeof cd.until === 'number' ? Math.max(0, Math.round((cd.until - Date.now()) / 1000)) : 0
                var cooling = cdLeft > 0
                // 已失效的块整体压暗；两类原因分别标注，便于分辨
                var chipStyle = Object.assign({}, S.chip, f ? S.chipFailed : {}, off ? S.chipDisabled : {})
                return e('span', {
                  key: k,
                  style: Object.assign({}, chipStyle, { gap: '3px' }),
                  title: [
                    f ? '当日失败（不参与路由）' : '',
                    off ? '已手动禁用（不参与路由）' : '',
                    cooling ? '并发已满，临时不参与路由（约 ' + cdLeft + 's 后自动恢复）' + (cd.reason ? '：' + cd.reason : '') : '',
                  ]
                    .filter(Boolean).join('；') || '点击右侧按钮可标记失败或禁用',
                },
                  'P' + (m.priority ?? 99) + (m.effort ? ' · ' + m.effort : '')
                    + (Number.isInteger(m.concurrency) && m.concurrency > 0 ? ' · 并发 ' + m.concurrency : '')
                    + ' ' + m.provider + '/' + m.model,
                  cooling && e('span', {
                    style: {
                      fontSize: '10px', padding: '0 4px', borderRadius: '3px',
                      background: 'var(--dsw-alias-state-warn-tertiary)',
                      color: 'var(--dsw-alias-state-warn-label)',
                    },
                  }, '并发 ' + cdLeft + 's'),
                  f && e('span', { style: { fontSize: '10px', opacity: .8 } }, '✕'),
                  // 失败：已失败则提供恢复，否则提供手动标记
                  f
                    ? e('button', {
                      style: S.chipBtn,
                      title: '恢复这个模型的失败状态（立即重新参与路由）',
                      onClick: function (ev) {
                        ev.stopPropagation()
                        apiSend(API + '/failed/reset', 'POST', { provider: m.provider, model: m.model }).then(refreshStatus)
                      },
                    }, '恢复')
                    : e('button', {
                      style: S.chipBtn,
                      title: '手动标记为当日失败（与自动失败同一份记录，可随时恢复）',
                      onClick: function (ev) {
                        ev.stopPropagation()
                        apiSend(API + '/failed/mark', 'POST', { provider: m.provider, model: m.model }).then(refreshStatus)
                      },
                    }, '失败'),
                  // 禁用：开/关写入分组条目的 disabled 字段（持久化，不随日期过期）
                  e('button', {
                    style: off ? Object.assign({}, S.chipBtn, S.chipBtnOn) : S.chipBtn,
                    title: off
                      ? '已禁用：在所有分组里都不参与路由。点击恢复参与路由'
                      : '禁用：在所有分组里都不再参与路由（持久，不像失败那样每天自动恢复）',
                    onClick: function (ev) {
                      ev.stopPropagation()
                      apiSend(API + '/groups/model-disabled', 'POST', {
                        provider: m.provider, model: m.model, disabled: !off,
                      }).then(refreshStatus)
                    },
                  }, off ? '启用' : '禁用'))
              })))
          }))
      }

      /**
       * 表头点击：升序 → 降序 → 回到默认序。
       * 三态循环让用户不必猜「再点一次会怎样」，也能明确退出排序。
       */
      function toggleSort(key) {
        if (!sort || sort.key !== key) { setSort({ key: key, dir: 'asc' }); return }
        if (sort.dir === 'asc') { setSort({ key: key, dir: 'desc' }); return }
        setSort(null)
      }

      /** 看板与分组页签共用的刷新：metrics 与 status 一起重取（并发上限两边都显示） */
      function refreshMetrics() {
        return Promise.all([loadMetrics(range), loadStatus()]).then(function (res) {
          if (res[0]) setMetrics(res[0])
          if (res[1]) setStatus(res[1])
        }).catch(function () { })
      }

      /**
       * 并发上限按模型持久化（POST /model-concurrency，对所有分组统一生效）。
       * 输入框是受控的本地草稿：合法正整数即提交，空/0 即传 null 回落到默认上限。
       * 回写草稿前比对当前值，避免响应回来时抹掉用户刚敲的新数字。
       */
      function commitConcurrency(provider, model, raw) {
        var k = keyOf(provider, model)
        var next = Object.assign({}, concDraft)
        next[k] = raw
        setConcDraft(next)
        var limit = validConc(raw)
        var blank = String(raw).trim() === '' || Number(raw) === 0
        if (limit === null && !blank) return
        apiSend(API + '/model-concurrency', 'POST', {
          provider: provider, model: model, concurrency: limit,
        }).catch(function () { }).then(function () {
          setConcDraft(function (prev) {
            if (prev[k] !== raw) return prev
            var cleared = Object.assign({}, prev)
            delete cleared[k]
            return cleared
          })
          return refreshMetrics()
        })
      }

      /**
       * 数据看板：把 /metrics 的每个模型摊平成一行，默认按分组 + 优先级排序。
       * metrics 行里没有 priority，用 status.groups 里的分组条目补齐；
       * 补不到时退化成 groupName/provider/model 排序，保证顺序稳定。
       *
       * sort 为 { key, dir } 时按该列覆盖默认序：同值由稳定排序保持默认序，
       * 而 null（无采样、不限并发）无论升降序都排在最后，避免空行挤走有用的行。
       */
      function metricsSortedRows(rawRows, sort) {
        var byKey = {}
        routeGroups.forEach(function (g) {
          var gm = g.models || []
          for (var i = 0; i < gm.length; i++) {
            byKey[keyOf(gm[i].provider, gm[i].model)] = { groupName: g.name, priority: gm[i].priority }
          }
        })
        var items = rawRows.map(function (r) {
          var meta = byKey[keyOf(r.provider, r.model)] || {}
          return {
            row: r,
            groupName: r.groupName || meta.groupName || '',
            priority: typeof meta.priority === 'number' ? meta.priority : 99,
          }
        }).sort(function (a, b) {
          if (a.groupName !== b.groupName) return a.groupName < b.groupName ? -1 : 1
          if (a.priority !== b.priority) return a.priority - b.priority
          if (a.row.provider !== b.row.provider) return a.row.provider < b.row.provider ? -1 : 1
          return a.row.model < b.row.model ? -1 : a.row.model > b.row.model ? 1 : 0
        })
        if (!sort || !sort.key) return items
        var dir = sort.dir === 'desc' ? -1 : 1
        return items.sort(function (a, b) {
          var av = metricsSortValue(a.row, sort.key)
          var bv = metricsSortValue(b.row, sort.key)
          var an = av === null || av === undefined
          var bn = bv === null || bv === undefined
          if (an && bn) return 0
          if (an) return 1
          if (bn) return -1
          if (av === bv) return 0
          return (av < bv ? -1 : 1) * dir
        })
      }

      /** 状态列权重：0 正常 → 1 已禁用 → 2 当日失败 → 3 并发冷却（▲ 健康在前，▼ 异常在前） */
      function metricsStatusRank(r) {
        if (isNum(r.capacityUntil) && r.capacityUntil > Date.now()) return 3
        if (r.failed) return 2
        if (r.disabled) return 1
        return 0
      }

      /** 某一列的排序值；null 表示「没有数据」，排序时恒定垫底 */
      function metricsSortValue(r, key) {
        if (key === 'model') return r.provider + '/' + r.model
        if (key === 'ttft') return isNum(r.ttftP50) ? r.ttftP50 : null
        if (key === 'tps') return isNum(r.tpsP50) ? r.tpsP50 : null
        // token 列按总用量排（输入 + 输出），没有 token 样本的行垫底
        if (key === 'tokens') {
          if (!isNum(r.inTokens) && !isNum(r.outTokens)) return null
          return (isNum(r.inTokens) ? r.inTokens : 0) + (isNum(r.outTokens) ? r.outTokens : 0)
        }
        // 并发列按「生效上限」排：不限（null）垫底，与显示一致
        if (key === 'conc') return Number.isInteger(r.concurrency) && r.concurrency > 0 ? r.concurrency : null
        return metricsStatusRank(r)
      }

      function dashboardTab() {
        var rows = (metrics && metrics.rows) || []
        // defaultConcurrency 以 metrics 为准，旧版 Host 没有该字段时回落到 status
        var fallbackConc = status && typeof status.defaultConcurrency === 'number' ? status.defaultConcurrency : null
        var defConc = metrics && typeof metrics.defaultConcurrency === 'number' ? metrics.defaultConcurrency : fallbackConc
        // 显式配置（按模型、对所有分组生效）在 status.modelConcurrency；
        // metrics 行里的 concurrency 是「生效上限」（已并入 defaultConcurrency）。
        var configured = (status && status.modelConcurrency) || {}
        var sorted = metricsSortedRows(rows, sort)
        var noneSampled = rows.length > 0 && rows.every(function (r) { return !(r.samples > 0) })
        var now = Date.now()
        var defaultHint = defConc === null ? '' : (defConc === 0 ? '当前默认不限' : '当前默认 ' + defConc)


        /** 表头：点击切 升序 → 降序 → 默认序；▲/▼ 标出当前排序列与方向 */
        function sortHead(key, label, numeric) {
          var on = !!sort && sort.key === key
          return e('button', {
            style: Object.assign({}, S.metricsSortBtn,
              numeric ? S.metricsSortBtnNum : {}, on ? S.metricsSortBtnOn : {}),
            title: on
              ? (sort.dir === 'desc' ? '已按' + label + '降序；点击切回升序' : '已按' + label + '升序；点击切为降序')
              : '点击按' + label + '排序（无数据的行恒排最后）',
            onClick: function () { toggleSort(key) },
          },
            e('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
            on && e('span', { style: S.metricsSortMark }, sort.dir === 'desc' ? '▼' : '▲'))
        }

        return e('div', { style: S.pane },
          e('div', { style: S.metricsHead },
            e('span', { style: { fontSize: '12px', fontWeight: 600 } }, '数据看板'),
            e('span', { style: { fontSize: '11px', opacity: .6 } },
              '默认并发上限：' + (defConc === null ? '—' : (defConc === 0 ? '不限（0）' : String(defConc)))),
            metrics && isNum(metrics.sampledAt) && e('span', { style: { fontSize: '11px', opacity: .5 } },
              '采样于 ' + new Date(metrics.sampledAt).toLocaleTimeString()),
            e('span', { style: { marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' } },
              e('button', {
                style: S.btn,
                onClick: function () { refreshMetrics() },
              }, '刷新'))),
          // 日期筛选：按北京时间整天。筛选在 Host 侧做（缓冲区只留最近 N 条，
          // 界面自己筛会把更早的样本算丢）。快捷区间覆盖最常用的三种看法。
          e('div', { style: S.metricsFilter },
            e('span', { style: { fontSize: '11px', opacity: .6, flexShrink: 0 } }, '日期'),
            e('input', {
              type: 'date', style: S.metricsDate,
              value: range.since, max: range.until || '',
              title: '起始日期（北京时间，含当天）',
              onChange: function (ev) { setRange({ since: ev.target.value, until: range.until }) },
            }),
            e('span', { style: { opacity: .45, fontSize: '11px' } }, '—'),
            e('input', {
              type: 'date', style: S.metricsDate,
              value: range.until, min: range.since || '',
              title: '结束日期（北京时间，含当天）',
              onChange: function (ev) { setRange({ since: range.since, until: ev.target.value }) },
            }),
            e('button', {
              style: Object.assign({}, S.btn, { padding: '1px 8px' }),
              title: '只看今天（北京时间）',
              onClick: function () { setRange({ since: beijingToday(), until: beijingToday() }) },
            }, '今天'),
            e('button', {
              style: Object.assign({}, S.btn, { padding: '1px 8px' }),
              title: '最近 7 天（北京时间）',
              onClick: function () { setRange({ since: beijingDaysAgo(6), until: beijingToday() }) },
            }, '近 7 天'),
            (range.since || range.until) && e('button', {
              style: Object.assign({}, S.btn, { padding: '1px 8px' }),
              title: '清除日期筛选，统计全部保留的样本',
              onClick: function () { setRange({ since: '', until: '' }) },
            }, '全部'),
            (range.since || range.until) && e('span', { style: { fontSize: '11px', opacity: .5 } },
              '已筛选，结果不含区间外的样本')),
          e('div', { style: { fontSize: '11px', opacity: .6, padding: '0 2px 6px' } },
            '首字 = 请求发出到第一个输出增量的时间；速度 = 输出 token / 生成耗时；'
            + 'token = 区间内该模型的输入/输出用量合计（只统计适配器报了 usage 的调用）；'
            + '并发 = 正在进行的请求 / 生效上限'
            + '（上限在「模型」页签的模型行上设置，对所有分组统一生效）。'),
          e('div', { style: S.metricsNote },
            '副行灰字是该列的补充：首字与速度给 P90，token 给输入用量，并发给等槽时间与排队数，'
            + '模型给所属分组与当日采样。采样与 token 用量会落盘，重启后仍在。'),
          noneSampled && e('div', { style: S.hint }, '还没有采样：跑一次会话后这里会出现首字与速度数据。'),
          metrics === null && e('div', { style: S.hint }, '正在读取采样数据…'),
          metrics !== null && rows.length === 0 && e('div', { style: S.hint }, '分组里还没有模型。'),

          rows.length > 0 && e('div', { style: S.metricsTable },
            e('div', { style: Object.assign({}, S.metricsRow, S.metricsRowHead) },
              sortHead('model', '模型', false),
              sortHead('ttft', '首字', true),
              sortHead('tps', '速度', true),
              sortHead('tokens', 'token', true),
              sortHead('conc', '并发', true),
              sortHead('status', '状态', false)),
            sorted.map(function (it) {
              var r = it.row
              var k = keyOf(r.provider, r.model)
              // 生效上限（已含默认值）：null = 不限
              var effConc = Number.isInteger(r.concurrency) && r.concurrency > 0 ? r.concurrency : null
              var effText = fmtConcLimit(effConc)
              // 显式配置：只有在这里配过的模型才非空
              var explicit = Number.isInteger(configured[k]) && configured[k] > 0 ? configured[k] : null
              var inflight = isNum(r.inflight) ? r.inflight : 0
              var queued = isNum(r.queued) ? r.queued : 0
              var cooling = isNum(r.capacityUntil) && r.capacityUntil > now
              var coolLeft = cooling ? Math.max(1, Math.round((r.capacityUntil - now) / 1000)) : 0
              var style = Object.assign({}, S.metricsRow,
                r.failed ? S.metricsRowFailed : {}, r.disabled ? S.metricsRowDisabled : {})
              // 副行只在有值时才画：没采样的行单行显示，不拿「P90 —」白占高度
              function p90Cell(p50, p90, fmt) {
                var has90 = isNum(p90)
                return e('div', { style: S.metricsNumCell },
                  e('span', { style: S.metricsNumMain }, fmt(p50)),
                  has90 && e('span', { style: S.metricsNumSub, title: 'P90 ' + fmt(p90) }, 'P90 ' + fmt(p90)))
              }
              // 并发副行：等槽时间优先，其次排队数；都没有就不画
              var concSub = isNum(r.waitP50) && r.waitP50 > 0 ? '等槽 ' + fmtMs(r.waitP50) : null
              var queueSub = queued > 0 ? '排队 ' + queued : null
              var concSubText = [concSub, queueSub].filter(Boolean).join(' · ')
              return e('div', { key: k, style: style },
                // 模型列允许折行：provider/model 再长也看全，title 兜底完整值
                e('div', { style: S.metricsCellModel },
                  e('div', {
                    style: S.metricsModel,
                    title: r.provider + '/' + r.model + (it.groupName ? '\n分组：' + it.groupName : ''),
                  }, r.provider + '/' + r.model),
                  e('div', { style: S.metricsSub },
                    (it.groupName ? it.groupName : '未分组')
                    + ' · ' + (isNum(r.okSamples) ? r.okSamples : 0) + '/' + (isNum(r.samples) ? r.samples : 0) + ' 成功')),
                p90Cell(r.ttftP50, r.ttftP90, fmtMs),
                p90Cell(r.tpsP50, r.tpsP90, fmtTps),
                // token：主行输出用量、副行输入用量（带 token 数的样本条数放 title）。
                // 没有 usage 的调用不计入；一条都没有时显示 —，不显示 0（0 会被读成「确实没用量」）。
                e('div', { style: S.metricsNumCell },
                  e('span', {
                    style: S.metricsNumMain,
                    title: '输出 token 合计（区间内）'
                      + (isNum(r.tokenSamples) ? '\n有 token 数据的样本：' + r.tokenSamples + ' / ' + (isNum(r.samples) ? r.samples : 0) : ''),
                  }, isNum(r.outTokens) && r.tokenSamples > 0 ? fmtTokens(r.outTokens) : '—'),
                  isNum(r.inTokens) && r.tokenSamples > 0 && e('span', {
                    style: S.metricsNumSub,
                    title: '输入 token 合计（区间内）',
                  }, '↑' + fmtTokens(r.inTokens))),
                // 并发：只读展示「进行中 / 上限」，上限在模型页签改
                e('div', { style: S.metricsNumCell },
                  e('span', {
                    style: S.metricsNumMain,
                    title: '正在进行的请求 / 生效上限' + (explicit === null ? '（跟随默认上限）' : '（本模型显式配置）')
                      + (queued > 0 ? '\n排队中：' + queued : ''),
                  }, String(inflight) + '/' + effText),
                  concSubText && e('span', { style: S.metricsNumSub }, concSubText)),
                // 状态：主行一个标签（失败 > 禁用 > 冷却 > 正常，只画最严重的那个，
                // 避免一格里堆三枚胶囊把列撑爆），副行是错误码。两者都截断 + title。
                e('div', { style: S.metricsTagCell },
                  r.failed
                    ? e('span', { style: S.tag, title: '当日失败：不参与路由，日界线或成功一轮后自动恢复' }, '当日失败')
                    : r.disabled
                      ? e('span', { style: Object.assign({}, S.tag, { opacity: .8 }), title: '已手动禁用，不参与路由' }, '已禁用')
                      : cooling
                        ? e('span', {
                          style: Object.assign({}, S.tag, {
                            background: 'var(--dsw-alias-state-warn-tertiary)',
                            color: 'var(--dsw-alias-state-warn-label)',
                          }),
                          title: '并发已满被临时挡在路由之外，约 ' + coolLeft + 's 后自动恢复'
                            + (r.capacityReason ? '：' + r.capacityReason : ''),
                        }, '冷却 ' + coolLeft + 's')
                        : e('span', { style: { fontSize: '11px', opacity: .45 } }, '正常'),
                  r.lastErrorCode && e('span', {
                    style: S.metricsNumSub,
                    title: '最近一次错误码：' + String(r.lastErrorCode),
                  }, String(r.lastErrorCode))))
            })))
      }

      function groupEditor(avail) {
        return e(GroupEditor, {
          key: 'ge',
          editing: editing,
          allModels: avail,
          onPatch: function (patch) { setEditing(Object.assign({}, editing, patch)) },
          onCancel: function () { setEditing(null) },
          onSaved: function () { setEditing(null); refreshStatus() },
        })
      }

      function failedTab() {
        var reasonLimit = 90
        return e('div', { style: S.pane },
          e('div', { style: S.hint }, '当日（按北京时间）彻底失败（所有重试耗尽）的模型不会参与路由；每天 ' + dayBoundaryText(status) + ' 自动重置，或点「恢复」立即重新启用。下面记录最近一次失败的原因（重启后保留，仅当日可见）。'),
          failedList.length === 0 && e('div', { style: S.hint }, '当日暂无失败模型。'),
          failedList.length > 0 && e('button', {
            style: Object.assign({}, S.btn, { marginBottom: '8px' }),
            onClick: function () { apiSend(API + '/failed/reset', 'POST', {}).then(refreshStatus) },
          }, '全部恢复'),
          failedList.map(function (f) {
            var fk = keyOf(f.provider, f.model)
            var isOpen = !!openFailures[fk]
            var reason = f.reason ? String(f.reason) : ''
            return e('div', { key: fk, style: Object.assign({}, S.row, { flexDirection: 'column', alignItems: 'stretch', gap: '4px' }) },
              e('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                e('span', { style: { flex: 1, fontSize: '12px' } }, f.provider + '/' + f.model + '（失败 ' + (f.count || 1) + ' 次）'),
                f.code && e('span', {
                  style: { fontSize: '10px', fontFamily: 'monospace', padding: '1px 5px', borderRadius: '3px', border: '0.5px solid var(--dsw-alias-border-l2)', opacity: .8 },
                  title: '错误码',
                }, String(f.code)),
                e('button', { style: S.btn, onClick: function () { reenable(f.provider, f.model) } }, '恢复')),
              e('div', { style: { fontSize: '11px', lineHeight: '1.5', opacity: .75, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                reason === ''
                  ? e('span', { style: { opacity: .55 } }, '（旧记录，暂无失败原因；下次该模型失败后会自动记录）')
                  : [
                      e('span', null, isOpen || reason.length <= reasonLimit ? reason : reason.slice(0, reasonLimit) + '…'),
                      reason.length > reasonLimit && e('button', {
                        style: { background: 'none', border: 'none', color: 'var(--dsw-alias-state-business-primary)', fontSize: '11px', cursor: 'pointer', padding: '0 4px', verticalAlign: 'baseline' },
                        onClick: function () {
                          var next = Object.assign({}, openFailures); next[fk] = !isOpen; setOpenFailures(next)
                        },
                      }, isOpen ? '收起' : '展开')])
            )
          }))
      }

      /* ---- 会话分组选择：选中即绑定本会话并按组内优先级路由 ---- */
      /** 两种绑定模式：route 直接用组内模型；failover 保持当前模型仅作故障兜底 */
      var MODES = [
        { id: 'route', name: '分组路由（用组内模型）', tip: '绑定即把会话切到组内优先级最高的可用模型，失败后自动换组内下一个' },
        { id: 'failover', name: '故障兜底（保持当前模型）', tip: '会话继续用你手动选的模型；仅当它彻底失败后才自动切到组内下一个' },
      ]

      function groupBar() {
        return e('div', { style: S.groupBar },
          e('span', { style: S.groupBarLabel }, '路由分组'),
          e('select', {
            style: S.select,
            value: binding || '',
            onChange: function (ev) {
              var v = ev.target.value
              bindGroup(v === '' ? null : v, bindingMode)
            },
          },
            [e('option', { key: '__none', value: '' }, '不绑定（手动选模型）')].concat(
              routeGroups.map(function (g) {
                return e('option', { key: g.id, value: g.id },
                  g.name + '（' + (g.models || []).length + ' 个模型' + (g.enabled ? '' : '，已停用') + '）')
              })
            )),
          props.subagent && e('span', {
            style: S.badge,
            title: '子代理会话默认继承父会话的路由分组；在这里单独选择只影响本子代理',
          }, '继承'),
          binding && e('select', {
            style: Object.assign({}, S.select, { flex: '0 0 auto', maxWidth: '168px' }),
            title: '绑定模式',
            value: bindingMode,
            onChange: function (ev) { bindGroup(binding, ev.target.value) },
          }, MODES.map(function (m) {
            return e('option', { key: m.id, value: m.id, title: m.tip }, m.name)
          })),
          boundGroup && e('span', { style: S.badge }, bindingMode === 'failover' ? '兜底中' : '路由中'),
          binding && !props.subagent && e('button', {
            style: Object.assign({}, S.btn, {
              padding: '1px 7px', fontSize: '11px', flex: '0 0 auto',
              ...(isDefault ? { borderColor: 'var(--dsw-alias-state-business-primary)', color: 'var(--dsw-alias-state-business-primary)' } : {}),
            }),
            title: isDefault
              ? '新会话已默认使用这个分组与模式。点击取消默认（之后新建的会话不自动绑定）'
              : '把这个分组与模式设为新会话的默认，以后新建会话自动沿用',
            onClick: function () {
              apiSend(API + '/default-group', 'POST', isDefault ? { groupId: null } : { groupId: binding, mode: bindingMode })
                .then(function () { return loadStatus() })
                .then(function (d) { if (d) setStatus(d) })
            },
          }, isDefault ? '✓ 新会话默认' : '设为新会话默认'))
      }

      /* ---- 弹窗 / 下拉 ---- */
      function dialog() {
        var visible = visibleGroups()
        var activeId = provider || (visible[0] && visible[0].id)
        var active = visible.find(function (g) { return g.id === activeId })
        var right
        if (tab === 'models') {
          right = e('div', { style: S.pane },
            groupBar(),
            e('input', { style: S.search, placeholder: '搜索模型…', value: query, onChange: function (ev) { setQuery(ev.target.value) } }),
            effortRow(),
            active && modelRows(active),
            (!active || active.models.length === 0) && e('div', { style: S.hint }, query.trim() ? '没有匹配的模型。' : '该提供商暂无可用模型。'))
        } else if (tab === 'groups') {
          right = groupTab()
        } else if (tab === 'dashboard') {
          right = dashboardTab()
        } else {
          right = failedTab()
        }
        // portal 到 body：跳出 composer 席位（sticky z-index:7）的层叠上下文，
        // 否则右侧栏等更高层级会盖住弹窗。
        return createPortal(
          e('div', { style: S.overlay, onClick: function (ev) { if (ev.target === ev.currentTarget) { setOpen(false); setQuery('') } } },
            e('div', { style: S.dialog, onClick: function (ev) { ev.stopPropagation() } },
            e('div', { style: S.dialogHead },
              e('span', { style: S.dialogTitle }, '选择模型'),
              boundGroup && e('span', { style: S.badge }, '分组：' + boundGroup.name),
              e('button', { style: S.btn, onClick: function () { setOpen(false); setQuery('') } }, '关闭')),
            e('div', { style: S.body },
              e('div', { style: S.left },
                e('div', { style: S.leftTitle }, '提供商'),
                e('div', { style: S.leftList }, visible.map(function (g) {
                  var isActive = g.id === activeId
                  return e('div', {
                    key: g.id, style: Object.assign({}, S.providerRow, isActive ? S.providerActive : {}),
                    // 左栏是「按提供商挑模型」的入口：在任何页签点它都回到模型页，
                    // 否则点了供应商却看不到它的模型（改动落在别的页签里）。
                    title: '查看 ' + providerName(g) + ' 的模型',
                    onClick: function () { setProvider(g.id); setTab('models') },
                  },
                    e('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, providerName(g)),
                    e('span', { style: S.count }, String(g.models.length)))
                }))),
              e('div', { style: S.right },
                e('div', { style: S.tabs },
                  e('button', { style: Object.assign({}, S.tab, tab === 'models' ? S.tabActive : {}), onClick: function () { setTab('models') } }, '模型'),
                  e('button', { style: Object.assign({}, S.tab, tab === 'groups' ? S.tabActive : {}), onClick: function () { setTab('groups') } }, '路由分组'),
                  e('button', { style: Object.assign({}, S.tab, tab === 'dashboard' ? S.tabActive : {}), onClick: function () { setTab('dashboard') } }, '数据看板'),
                  e('button', { style: Object.assign({}, S.tab, tab === 'failed' ? S.tabActive : {}), onClick: function () { setTab('failed') } }, '失败模型' + (failedList.length ? ' (' + failedList.length + ')' : ''))),
                right))),
          // 编辑器提到弹窗根层级：从任意页签（含模型页签的 ＋ 快捷入组）触发都能显示
          editing && groupEditor(poolOf(catalog, status))),
          document.body)
      }

      function dropdown() {
        var visible = visibleGroups()
        return createPortal(
          e('div', { style: S.overlay, onClick: function (ev) { if (ev.target === ev.currentTarget) { setOpen(false); setQuery('') } } },
          e('div', { style: Object.assign({}, S.dialog, { width: 'min(92vw, 420px)', height: 'auto', maxHeight: 'min(82vh, 460px)' }), onClick: function (ev) { ev.stopPropagation() } },
            e('div', { style: S.dialogHead },
              e('span', { style: S.dialogTitle }, '选择模型'),
              boundGroup && e('span', { style: S.badge }, '分组：' + boundGroup.name)),
            e('div', { style: { padding: '6px 10px 10px', overflowY: 'auto' } },
              groupBar(),
              e('input', { style: S.search, placeholder: '搜索模型…', value: query, onChange: function (ev) { setQuery(ev.target.value) } }),
              effortRow(),
              visible.map(function (g) {
                return e('div', { key: g.id },
                  e('div', { style: { fontSize: '11px', opacity: .55, padding: '6px 2px 2px' } }, providerName(g)),
                  modelRows(g))
              }))),
          editing && groupEditor(poolOf(catalog, status))),
          document.body)
      }

      return e('div', { style: { position: 'relative', minWidth: 0 }, 'data-mfm': VERSION },
        e('button', {
          style: S.trigger, title: triggerText, disabled: props.locked || snap.status === 'loading',
          'aria-label': '选择模型，当前 ' + (providerLabel ? providerLabel + ' 的 ' : '') + label,
          onClick: function () { setOpen(true); setQuery(''); if (dialogMode) setTab('models') },
        },
          providerLabel && e('span', { style: S.triggerProvider }, providerLabel),
          providerLabel && e('span', { style: S.triggerSep }, '·'),
          e('span', { style: S.triggerName }, label),
          boundGroup && e('span', { style: S.badge }, boundGroup.name),
          effortLabel && e('span', { style: { flexShrink: 1000, color: 'var(--dsw-alias-label-caption, inherit)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, effortLabel)),
        open && (dialogMode ? dialog() : dropdown()))
    }

    /* ==================================================== 分组编辑器 ==== */
    // 模块级组件：稳定身份，避免父组件 render 时重挂载导致输入框失焦。
    /** 已添加模型每页条数：模型多时保持下方搜索/添加区可见 */
    var ADDED_PAGE_SIZE = 8

    function GroupEditor(props) {
      var editing = props.editing
      var isNew = editing.action === 'new'
      var models = editing.models
      var chosen = {}
      models.forEach(function (m) { chosen[keyOf(m.provider, m.model)] = true })
      var allModels = props.allModels
      var searchPair = React.useState(''); var search = searchPair[0]; var setSearch = searchPair[1]
      var pagePair = React.useState(0); var page = pagePair[0]; var setPage = pagePair[1]
      var groupByPair = React.useState(true); var groupByProvider = groupByPair[0]; var setGroupByProvider = groupByPair[1]
      /** 时段/截止弹框正在编辑的模型：{ index, entry, wins } */
      var schedulePair = React.useState(null); var scheduleFor = schedulePair[0]; var setScheduleFor = schedulePair[1]
      var needle = search.trim().toLowerCase()
      var avail = allModels.filter(function (m) {
        if (chosen[keyOf(m.provider, m.model)]) return false
        if (!needle) return true
        return (m.provider + '/' + m.model + ' ' + (m.name || '')).toLowerCase().indexOf(needle) >= 0
      })

      /** 目录里的模型信息（思考强度候选、显示名） */
      var infoOf = {}
      allModels.forEach(function (m) { infoOf[keyOf(m.provider, m.model)] = m })

      /** 按供应商聚合全部已添加模型（组间保持首次出现顺序，组内保持登记顺序） */
      function providerGroups() {
        var out = []
        var byProvider = {}
        models.forEach(function (m, idx) {
          var key = m.provider
          if (!byProvider[key]) { byProvider[key] = { provider: key, items: [] }; out.push(byProvider[key]) }
          byProvider[key].items.push({ entry: m, index: idx })
        })
        return out
      }

      /**
       * 分页。开启「按供应商分组」时以**整组**为单位装页：
       * 同供应商的模型永远在同一页，页大小按模型数近似控制；
       * 单个超大供应商组自成一页。关闭分组时按条切页。
       */
      var pages = []
      if (groupByProvider) {
        var curGroups = []
        var curCount = 0
        providerGroups().forEach(function (g) {
          if (curGroups.length > 0 && curCount + g.items.length > ADDED_PAGE_SIZE) {
            pages.push(curGroups); curGroups = []; curCount = 0
          }
          curGroups.push(g)
          curCount += g.items.length
        })
        if (curGroups.length > 0) pages.push(curGroups)
      } else {
        for (var p = 0; p < models.length; p += ADDED_PAGE_SIZE) {
          var chunk = []
          for (var c = p; c < Math.min(p + ADDED_PAGE_SIZE, models.length); c++) {
            chunk.push({ entry: models[c], index: c })
          }
          pages.push(chunk)
        }
      }
      var pageCount = Math.max(1, pages.length)
      var safePage = Math.min(page, pageCount - 1)
      var pageData = pages[safePage] || []

      function patchModelAt(index, patch) {
        var list = models.slice()
        var next = Object.assign({}, list[index], patch)
        Object.keys(next).forEach(function (k) { if (next[k] === undefined) delete next[k] })
        list[index] = next
        props.onPatch({ models: list })
      }

      /** 一行：优先级 + 名称 + 思考强度 + 时段摘要 + ⏱（打开时段弹框）+ 移除 */
      function modelRow(entry, index) {
        var info = infoOf[keyOf(entry.provider, entry.model)]
        var efforts = info && info.efforts
        var rowKey = keyOf(entry.provider, entry.model)
        var wins = Array.isArray(entry.windows) ? entry.windows : []
        // 兼容尚未迁移的旧数据（单 from/to）
        if (wins.length === 0 && entry.from !== undefined && entry.from !== null
          && entry.to !== undefined && entry.to !== null) wins = [{ from: entry.from, to: entry.to }]
        var configured = wins.length > 0 || !!entry.until
        var summary = wins.map(function (w) {
          return w.from + '–' + w.to + (Number(w.from) > Number(w.to) ? '(跨)' : '')
        }).join('、') + (entry.until ? ' 止' + String(entry.until).slice(5) : '')
        return e('div', { key: rowKey },
          e('div', { style: S.row },
            e('input', {
              type: 'number', min: '1', max: '999', style: S.prio, value: entry.priority ?? 99,
              onChange: function (ev) {
                patchModelAt(index, { priority: Math.max(1, Math.min(999, Number(ev.target.value) || 99)) })
              },
            }),
            // 并发上限不在这里配：它按模型、对所有分组统一生效，配置入口在数据看板
            e('span', {
              style: { flex: 1, fontSize: '12px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: entry.provider + '/' + entry.model,
            }, (info && info.name ? info.name + ' ' : '') + entry.provider + '/' + entry.model),
            efforts && efforts.length > 0 && e('select', {
              style: Object.assign({}, S.select, { flex: '0 0 auto', maxWidth: '110px' }),
              title: '思考强度',
              value: entry.effort || '',
              onChange: function (ev) {
                patchModelAt(index, { effort: ev.target.value === '' ? undefined : ev.target.value })
              },
            },
              [e('option', { key: '', value: '' }, '强度·默认' + (info.defaultEffort ? '（' + ((efforts.find(function (lv) { return lv.id === info.defaultEffort }) || {}).name || info.defaultEffort) + '）' : ''))].concat(
                efforts.map(function (lv) {
                  return e('option', { key: lv.id, value: lv.id }, '强度·' + (lv.name || lv.id))
                })
              )),
            configured && e('span', {
              style: { fontSize: '10px', opacity: .75, whiteSpace: 'nowrap', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis' },
              title: '已配置：' + (wins.length ? summary.replace(/、/g, '、') + ' 时' : '全天') + (entry.until ? '，截止 ' + entry.until : ''),
            }, summary || '全天'),
            e('button', {
              style: Object.assign({}, S.btn, { padding: '1px 6px', fontSize: '11px' }),
              title: '设置该模型参与路由的时段与截止日期',
              onClick: function () { setScheduleFor({ index: index, key: rowKey }) },
            }, '⏱'),
            e('button', {
              style: S.btnDanger,
              onClick: function () {
                props.onPatch({ models: models.filter(function (_, j) { return j !== index }) })
              },
            }, '移除')))
      }

      /** 时段/截止弹框：一个模型可配多段，每段两端包含，from>to 表示跨午夜 */
      function scheduleDialog() {
        if (!scheduleFor) return null
        var index = scheduleFor.index
        // 每次渲染都从最新的 models 读取，避免弹框里连续编辑时基于陈旧快照
        var live = models[index]
        if (!live) { return null }
        var rawWins = Array.isArray(live.windows) ? live.windows : []
        if (rawWins.length === 0 && live.from !== undefined && live.from !== null
          && live.to !== undefined && live.to !== null) rawWins = [{ from: live.from, to: live.to }]
        var wins = rawWins.filter(function (w) { return w && w.from !== undefined && w.to !== undefined })
        var until = typeof live.until === 'string' ? live.until : ''
        var hourOptions = []
        for (var h = 0; h < 24; h++) hourOptions.push(e('option', { key: h, value: String(h) }, String(h) + ' 时'))
        var winStyle = Object.assign({}, S.select, { flex: '0 0 auto', width: '76px' })

        function commit(nextWins, nextUntil) {
          patchModelAt(index, {
            windows: (nextWins && nextWins.length) ? nextWins : undefined,
            from: undefined,
            to: undefined,
            until: (typeof nextUntil === 'string' && nextUntil !== '') ? nextUntil : undefined,
          })
        }
        function row(w, i) {
          var cross = Number(w.from) > Number(w.to)
          return e('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: '4px', padding: '3px 0' } },
            e('span', { style: { fontSize: '11px', opacity: .55, width: '18px' } }, String(i + 1)),
            e('select', {
              style: winStyle, value: String(w.from),
              onChange: function (ev) { var n = wins.slice(); n[i] = { from: Number(ev.target.value), to: w.to }; commit(n, until) },
            }, hourOptions),
            e('span', { style: { opacity: .5 } }, '—'),
            e('select', {
              style: winStyle, value: String(w.to),
              onChange: function (ev) { var n = wins.slice(); n[i] = { from: w.from, to: Number(ev.target.value) }; commit(n, until) },
            }, hourOptions),
            cross && e('span', { style: { fontSize: '10px', opacity: .6 } }, '跨午夜'),
            e('button', {
              style: S.btnDanger,
              onClick: function () { var n = wins.slice(); n.splice(i, 1); commit(n, until) },
            }, '删除'))
        }

        return createPortal(
          e('div', { style: Object.assign({}, S.modalBg, { zIndex: 2001 }), onClick: function (ev) { if (ev.target === ev.currentTarget) setScheduleFor(null) } },
            e('div', { style: Object.assign({}, S.modal, { maxWidth: '420px', zIndex: 2001 }) },
            e('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } }, '参与路由的时段'),
            e('div', { style: { fontSize: '11px', opacity: .65, marginBottom: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
              ((infoOf[keyOf(live.provider, live.model)] || {}).name || (live.provider + '/' + live.model)) + ''),
            e('div', { style: { fontSize: '11px', opacity: .6, marginBottom: '6px' } },
              '可添加多段，命中任意一段即参与路由。时刻为整点、两端包含；开始大于结束表示跨午夜（如 22–6）。不添加任何时段 = 全天参与。'),
            wins.map(row),
            wins.length === 0 && e('div', { style: S.hint }, '未设置时段，当前为全天参与。'),
            e('button', {
              style: Object.assign({}, S.btn, { marginTop: '4px' }),
              onClick: function () { commit(wins.concat([{ from: 9, to: 18 }]), until) },
            }, '＋ 添加时段'),
            e('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', paddingTop: '8px', borderTop: '0.5px solid var(--dsw-alias-border-l2)' } },
              e('span', { style: { fontSize: '11px', opacity: .7 } }, '截止日期'),
              e('input', {
                type: 'date', style: Object.assign({}, S.input, { flex: 1, padding: '2px 6px', fontSize: '11px' }),
                title: '设置后，当前日期超过它该模型不再参与路由；留空 = 不过期',
                value: until,
                onChange: function (ev) { commit(wins, ev.target.value) },
              })),
            e('div', { style: { fontSize: '10px', opacity: .5, marginTop: '4px' } }, '当天仍参与，次日（本地日期）起失效。'),
            e('div', { style: S.foot },
              e('button', { style: S.btn, onClick: function () { setScheduleFor(null) } }, '关闭')))),
          document.body)
      }

      var addedSection = []
      if (models.length > 0) {
        addedSection.push(e('div', {
          key: 'added-head',
          style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' },
        },
          e('span', { style: { fontSize: '11px', opacity: .7 } }, '已添加 ' + models.length + ' 个（按优先级路由）'),
          e('label', { style: { display: 'flex', alignItems: 'center', gap: '3px', fontSize: '11px', opacity: .7, cursor: 'pointer', marginLeft: 'auto' } },
            e('input', {
              type: 'checkbox', checked: groupByProvider,
              onChange: function (ev) { setGroupByProvider(ev.target.checked) },
            }),
            '按供应商分组'),
          pageCount > 1 && e('span', { style: { fontSize: '11px', opacity: .7 } },
            '第 ' + (safePage + 1) + '/' + pageCount + ' 页'),
          pageCount > 1 && e('button', {
            style: Object.assign({}, S.btn, { padding: '1px 8px' }),
            disabled: safePage === 0,
            onClick: function () { setPage(Math.max(0, safePage - 1)) },
          }, '上一页'),
          pageCount > 1 && e('button', {
            style: Object.assign({}, S.btn, { padding: '1px 8px' }),
            disabled: safePage >= pageCount - 1,
            onClick: function () { setPage(Math.min(pageCount - 1, safePage + 1)) },
          }, '下一页')))

        if (groupByProvider) {
          pageData.forEach(function (grp) {
            var pInfo = infoOf[keyOf(grp.provider, grp.items[0].entry.model)]
            addedSection.push(e('div', { key: 'p-' + grp.provider },
              e('div', { style: { fontSize: '11px', opacity: .55, padding: '4px 2px 2px' } },
                (pInfo && pInfo.providerName ? pInfo.providerName + ' · ' : '') + grp.provider),
              grp.items.map(function (it) { return modelRow(it.entry, it.index) })))
          })
        } else {
          pageData.forEach(function (it) { addedSection.push(modelRow(it.entry, it.index)) })
        }

        if (pageCount > 1) {
          addedSection.push(e('div', {
            key: 'pager',
            style: { display: 'flex', gap: '3px', flexWrap: 'wrap', padding: '6px 0 2px' },
          }, Array.from({ length: pageCount }, function (_, i) {
            return e('button', {
              key: i,
              style: Object.assign({}, S.btn, { padding: '1px 7px', ...(i === safePage ? { borderColor: 'var(--dsw-alias-state-business-primary)', color: 'var(--dsw-alias-state-business-primary)' } : {}) }),
              onClick: function () { setPage(i) },
            }, String(i + 1))
          })))
        }
      }

      return e(React.Fragment, null,
        createPortal(
        e('div', { style: S.modalBg, onClick: function (ev) { if (ev.target === ev.currentTarget) props.onCancel() } },
          e('div', { style: S.modal },
          e('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '10px' } }, isNew ? '新建路由分组' : '编辑路由分组'),
          e('label', { style: { fontSize: '11px', opacity: .7 } }, '分组名称'),
          e('input', {
            style: Object.assign({}, S.input, { margin: '4px 0 10px' }), value: editing.name, placeholder: '例如：主工作流',
            onChange: function (ev) { props.onPatch({ name: ev.target.value, error: null }) },
          }),
          models.length === 0 && e('div', { style: { fontSize: '11px', opacity: .7, marginBottom: '4px' } }, '路由模型与优先级（数字越小越优先）'),
          models.length === 0 && e('div', { style: S.hint }, '尚未添加模型'),
          addedSection,
          e('div', { style: { fontSize: '11px', opacity: .7, margin: '10px 0 4px' } }, '可选模型（点击添加，共 ' + allModels.length + ' 个）'),
          e('input', {
            style: Object.assign({}, S.input, { marginBottom: '4px' }), placeholder: '搜索模型…', value: search,
            onChange: function (ev) { setSearch(ev.target.value) },
          }),
          e('div', { style: { maxHeight: '180px', overflowY: 'auto' } }, avail.length === 0
            ? e('div', { style: S.hint }, needle ? '没有匹配的模型。' : '所有模型都已添加。')
            : avail.map(function (m) {
              return e('div', {
                key: keyOf(m.provider, m.model), style: Object.assign({}, S.modelRow, { fontSize: '12px' }),
                onClick: function () { props.onPatch({ models: models.concat([{ provider: m.provider, model: m.model, priority: 99 }]), error: null }) },
                onMouseEnter: function (ev) { ev.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' },
                onMouseLeave: function (ev) { ev.currentTarget.style.background = '' },
              }, (m.name ? m.name + ' ' : '') + m.provider + '/' + m.model + (m.failed ? '（当日失败）' : ''))
            })),
          editing.error && e('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)', marginTop: '8px' } }, editing.error),
          e('div', { style: S.foot },
            e('button', { style: S.btn, onClick: props.onCancel }, '取消'),
            e('button', {
              style: S.btnPrimary,
              onClick: function () {
                var n = (editing.name || '').trim()
                if (!n) { props.onPatch({ error: '请填写分组名称' }); return }
                // 允许先建空分组：模型可稍后从模型列表的 ＋ 快捷加入
                var body = { name: n, models: models, enabled: true }
                var call = isNew ? apiSend(API + '/groups', 'POST', body) : apiSend(API + '/groups', 'PUT', Object.assign({ id: editing.id }, body))
                call.then(function (r) {
                  if (r && r.ok) props.onSaved()
                  else props.onPatch({ error: (r && r.error) || '保存失败' })
                }).catch(function (err) {
                  props.onPatch({ error: String((err && err.message) || err) })
                })
              },
            }, isNew ? '创建' : '保存')))),
        document.body),
        scheduleDialog())
    }

    /* ====================================================== 设置页组件 == */
    function SettingsSection() {
      var stPair = React.useState(statusCache); var status = stPair[0]; var setStatus = stPair[1]
      var editPair = React.useState(null); var editing = editPair[0]; var setEditing = editPair[1]
      var catPair = React.useState(catalogCache); var catalog = catPair[0]; var setCatalog = catPair[1]

      React.useEffect(function () {
        loadStatus().then(function (d) { if (d) setStatus(d) })
        loadCatalog().then(function (c) { if (c) setCatalog(c) })
        var t = setInterval(function () { loadStatus().then(function (d) { if (d) setStatus(d) }) }, 5000)
        return function () { clearInterval(t) }
      }, [])

      var groups = (status && status.groups) || []
      var failed = (status && status.failed) || []
      var allModels = poolOf(catalog, status)
      var dialogMode = !!(status && status.settings && status.settings.dialogMode)
      var failedMap = {}
      failed.forEach(function (f) { failedMap[keyOf(f.provider, f.model)] = true })

      function refresh() { loadStatus().then(function (d) { if (d) setStatus(d) }) }
      function toggleDialog() {
        apiSend(API + '/settings', 'POST', { dialogMode: !dialogMode }).then(refresh)
      }

      return e('div', { style: S.settingsRoot },
        e('div', { style: S.settingsTitle }, '模型故障转移'),
        e('div', { style: S.settingsSub }, '按优先级路由模型：会话绑定分组后，每次请求使用组内优先级最高（数字最小）的可用模型；模型在所有重试后彻底失败会被标记为当日（按北京时间）失败并自动跳到下一个。会话成功跑完一轮会自动恢复该模型。'),

        e('div', { style: S.toggleRow },
          e('button', {
            style: Object.assign({}, S.toggle, dialogMode ? S.toggleOn : {}),
            'aria-pressed': dialogMode, 'aria-label': '模型选择弹窗',
            onClick: toggleDialog,
          }, e('span', { style: Object.assign({}, S.toggleKnob, dialogMode ? S.toggleKnobOn : {}) })),
          e('div', null,
            e('div', { style: { fontSize: '13px', fontWeight: 600 } }, '模型选择使用弹窗'),
            e('div', { style: { fontSize: '11px', opacity: .6 } }, '开启后会话输入框的模型选择改为左右分区弹窗（左：提供商，右：模型）；关闭时使用紧凑下拉列表。'))),

        e('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
          e('span', { style: { fontSize: '13px', fontWeight: 600 } }, '路由分组'),
          e('button', { style: S.btn, onClick: function () { setEditing({ action: 'new', name: '', models: [] }) } }, '＋ 新建')),
        groups.length === 0 && e('div', { style: S.hint }, '还没有分组。新建分组并把模型按优先级排序，然后在会话的模型弹窗里「绑定到本会话」。'),
        groups.map(function (g) {
          var sorted = (g.models || []).slice().sort(function (a, b) { return (a.priority ?? 99) - (b.priority ?? 99) })
          return e('div', { key: g.id, style: S.groupCard },
            e('div', { style: S.groupHead },
              e('span', { style: { fontWeight: 600, fontSize: '13px' } }, g.name),
              e('span', { style: { fontSize: '11px', opacity: .5 } }, g.models.length + ' 个模型'),
              e('span', { style: { marginLeft: 'auto', fontSize: '11px', opacity: .6 } }, g.enabled ? '已启用' : '已停用'),
              e('button', { style: S.btn, onClick: function () { setEditing({ action: 'edit', id: g.id, name: g.name, models: (g.models || []).slice() }) } }, '编辑'),
              e('button', {
                style: S.btn,
                onClick: function () { apiSend(API + '/groups', 'PUT', { id: g.id, enabled: !g.enabled }).then(refresh) },
              }, g.enabled ? '停用' : '启用'),
              e('button', {
                style: S.btnDanger,
                onClick: function () { fetch(API + '/groups/' + encodeURIComponent(g.id), { method: 'DELETE', credentials: 'same-origin' }).then(refresh) },
              }, '删除')),
            e('div', null, sorted.map(function (m) {
              var f = failedMap[keyOf(m.provider, m.model)] === true
              return e('span', { key: keyOf(m.provider, m.model), style: Object.assign({}, S.chip, f ? S.chipFailed : {}) },
                'P' + (m.priority ?? 99) + ' ' + m.provider + '/' + m.model + (f ? ' ✕' : ''))
            })))
        }),

        e('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '16px 0 6px' } },
          e('span', { style: { fontSize: '13px', fontWeight: 600 } }, '当日失败模型 (' + failed.length + ')'),
          failed.length > 0 && e('button', { style: S.btn, onClick: function () { apiSend(API + '/failed/reset', 'POST', {}).then(refresh) } }, '全部恢复')),
        failed.length === 0
          ? e('div', { style: S.hint }, '无失败记录。')
          : failed.map(function (f) {
            return e('div', { key: keyOf(f.provider, f.model), style: S.row },
              e('span', { style: { flex: 1, fontSize: '12px' } }, f.provider + '/' + f.model + '（失败 ' + (f.count || 1) + ' 次）'),
              e('button', { style: S.btn, onClick: function () { apiSend(API + '/failed/reset', 'POST', { provider: f.provider, model: f.model }).then(refresh) } }, '恢复'))
          }),
        e('div', { style: { fontSize: '11px', opacity: .5, marginTop: '16px' } }, '失败状态每天 ' + dayBoundaryText(status) + ' 自动重置（日界线可在 cordis.yml 的 failResetHour 调）；会话成功完成一轮也会立即恢复对应模型。'),
        editing && e(GroupEditor, {
          key: 'editor',
          editing: editing,
          allModels: allModels,
          onPatch: function (patch) { setEditing(Object.assign({}, editing, patch)) },
          onCancel: function () { setEditing(null) },
          onSaved: function () { setEditing(null); refresh() },
        }))
    }

    /* --------------------------------------------------------- register -- */
    // directoryFor() 内部读取 ctx.remote.session，且服务方法运行在调用方 ctx
    // 追踪器下，因此必须声明 remote 与 remote.session（与内置 ui-model-selection 一致）。
    exports.inject = ['slots', 'modelDirectories', 'sessions', 'remote', 'remote.session']
    exports.apply = function (ctx) {
      runtimeCtx = ctx
      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: 'model-failover', order: 66, label: '模型故障转移' },
            SettingsSection,
          )
        })
      } catch (error) { console.error('[model-failover] settings section registration failed', error) }

      try {
        ctx.slots.inject('conversation.input.model', function () {
          return ctx.slots.register({
            name: 'conversation.input.model',
            priority: -1,
            inject: function (sessionId) {
              var directory = ctx.modelDirectories.directoryFor(sessionId)
              // 子代理会话也支持选模型：宿主的 sessionController.selectModel 对
              // origin === 'subagent' 的会话一律硬拒绝（session/agent-busy，
              // "owned by subagent routing"），因此这类会话改走本插件自己的
              // /session-model —— Host 调 agent.model.select() 写入本会话的模型选择。
              var subagent = ctx.sessions.subagentAddress(sessionId) !== undefined
              return {
                sessionId: sessionId,
                available: true,
                subagent: subagent,
                store: directory.store,
                load: function () {
                  if (subagent) { loadStatus(); return }
                  directory.load().catch(function () { })
                },
                select: function (selection) {
                  if (!subagent) return directory.select(selection)
                  var body = { sessionId: sessionId, provider: selection.provider, model: selection.model }
                  if (selection.reasoningEffort !== undefined) body.reasoningEffort = selection.reasoningEffort
                  return apiSend(API + '/session-model', 'POST', body).then(function () {
                    return loadStatus().then(function () { return undefined })
                  })
                },
              }
            },
          }, ModelSeat)
        })
      } catch (error) { console.error('[model-failover] model seat registration failed', error) }
    }

    return module.exports
  },
})
