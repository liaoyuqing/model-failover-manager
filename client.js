/**
 * model-failover-manager — Client 浏览器半（DSH dynamic client bundle）。
 *
 * 1. 接管 composer 的模型选择位（conversation.input.model，priority -1 遮蔽原实现）：
 *    - 设置项 dialogMode 开启时，点击弹左右分区弹窗（左：提供商，右：模型）
 *    - 关闭时，紧凑下拉列表
 *    - 弹窗内含「路由分组」「数据看板」「失败模型」页签；分组可绑定到当前会话
 * 2. 设置页「模型故障转移」：dialogMode 开关 + 分组 CRUD（含优先级）+ 失败模型恢复
 * 3. 数据看板：读 /metrics 展示每个模型的首字延迟、输出速度、并发占用与等槽，
 *    表头可点击排序（结果被记住）；并发上限在并发列直接改；模型行可单独测速、
 *    从路由移除，当日失败的行可恢复；排序顺眼时可按当前排序重设路由优先级，
 *    也能对整组一键测速。
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
    var VERSION = 'v17'

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
      /** 操作条：分组选择 + 起始优先级 + 重设按钮 + 一键测速（表格正上方） */
      metricsActions: {
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        padding: '6px 8px', marginBottom: '6px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-bg-layer-2)',
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
      // 七列：模型 / 成功率 / 首字 / 速度 / token / 并发 / 状态。状态列固定宽，否则「当日失败 +
      // 错误码」会把 auto 列撑宽、把模型列从 308px 压到 248px，整张表看着就乱了。
      // 并发列 96px：上行输入框，下行「N/上限」加等槽时间与等槽位数。再窄末尾就会被
      // 省略号吃掉，而那一段正是要看的数。
      // token 列比速度列宽一点：它要放「1.2M」大字加「↑输入 12.3K」这种一行一个的小字。
      // 成功率列只放「98.5%」加副行「166/168」：主值够宽就够，副行靠 10px 字号塞进同一格。
      // 状态列 120px：副行要同时放下错误码与「恢复」按钮（错误码截断，完整报错走悬停）。
      metricsRow: {
        display: 'grid',
        gridTemplateColumns: 'minmax(120px, 1fr) 56px 66px 82px 108px 96px 120px',
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
      // token 列的大字：比同表其它主值大一档（15px 对 12px），它是看板上最常被
      // 拿来横向比的一个数。字号只加在这里，其它列保持安静。
      metricsNumBig: { fontSize: '15px', fontWeight: 600, letterSpacing: '-.2px' },
      // 模型名：允许折行（break-word 兜住没有空格的长 id）
      metricsCellModel: { minWidth: 0, whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: '1.35' },
      metricsTagCell: {
        minWidth: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'flex-start', gap: '1px', lineHeight: '1.3',
      },
      // 状态列的副行：错误码占满剩余宽度（截断显示，悬停给完整报错）。
      metricsErrCode: {
        minWidth: 0, width: '100%', maxWidth: '100%', fontSize: '10px', fontFamily: 'monospace',
        opacity: .75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      },
      // 状态标签与「恢复」按钮同一行：按钮紧跟在「当日失败」标签后面，
      // 副行留给错误码——两者挤在一行会把错误码挤成省略号。
      metricsTagLine: {
        minWidth: 0, maxWidth: '100%', display: 'flex', alignItems: 'center', gap: '4px',
      },
      metricsModel: { fontWeight: 600 },
      metricsSub: { fontSize: '10px', opacity: .6, marginTop: '1px', whiteSpace: 'normal', wordBreak: 'break-word' },
      // 模型名下的副行：分组名靠左，单模型「测速」按钮靠右。看板只有七列，
      // 再加一列会把模型列压到看不清 provider，所以按钮挂在这一行上。
      metricsSubLine: {
        display: 'flex', alignItems: 'center', gap: '6px', marginTop: '1px', minWidth: 0,
      },
      metricsSubText: {
        minWidth: 0, fontSize: '10px', opacity: .6,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      // 单模型测速：比操作条里的「一键测速」小一档，它只是这一行的动作
      metricsProbeBtn: {
        flexShrink: 0, marginLeft: 'auto', cursor: 'pointer',
        padding: '0 6px', fontSize: '10px', lineHeight: '15px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
      },
      // 行内的次级动作（从路由移除、恢复失败）：与测速按钮同一套观感，但不带
      // marginLeft:auto——它左边还有分组名，贴住即可。
      metricsMiniBtn: {
        flexShrink: 0, cursor: 'pointer',
        padding: '0 5px', fontSize: '10px', lineHeight: '15px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
      },
      // 并发列的上行：上限输入框独占，进行中与上限的读数在下行。
      // 改上限不必切到「模型」页签，提交逻辑与那边共用同一份（按模型持久化，
      // 对所有分组生效）。
      metricsConcEdit: {
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        gap: '4px', width: '100%',
      },
      // 并发副行：放的是实时数字，不能像 P90 那样淡到只剩暗示；但它仍是副行，
      // 字号只到 11px、透明度只到 .7，不该盖过上面的输入框。
      metricsConcSub: {
        fontSize: '11px', opacity: .7, fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
      },
      metricsConcInput: {
        width: '38px', textAlign: 'center', boxSizing: 'border-box', flexShrink: 0,
        background: 'var(--dsw-alias-bg-base)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: '4px', padding: '1px 2px', fontSize: '11px',
        color: 'var(--dsw-alias-label-primary)', outline: 'none',
        fontVariantNumeric: 'tabular-nums',
      },
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
    /**
     * 并发列的主值：进行中 / 生效上限；没配上限时上限位写「不限」。
     *
     * 进行中与上限是两个独立事实（limit 为 null 也照常统计进行中），所以不限的
     * 模型不能只写「不限」——那会让人以为这个数没有意义。
     */
    function fmtInflight(inflight, limit) {
      return String(inflight) + (limit === null ? '（不限）' : '/' + String(limit))
    }
    /** 压缩计数写法：1234 → 1.2K，1234567 → 1.2M；保留一位小数，够看板比对用量 */
    function fmtTokens(v) {
      if (!isNum(v)) return '—'
      if (v < 1000) return String(Math.round(v))
      if (v < 1e6) return (Math.round(v / 100) / 10).toFixed(1) + 'K'
      return (Math.round(v / 1e5) / 10).toFixed(1) + 'M'
    }
    /**
     * 成功率：ok / samples 的百分比。保留一位小数，但 100% 与 0% 不加小数——
     * 只有这两种是「全对 / 全错」，多写个 .0 反而像还有误差。
     * 分母为 0（还没采样）返回 null，由调用方画 —。
     */
    function fmtRate(ok, samples) {
      if (!isNum(ok) || !isNum(samples) || samples <= 0) return null
      var ratio = Math.max(0, Math.min(1, ok / samples))
      if (ratio >= 1) return '100%'
      if (ratio <= 0) return '0%'
      return (Math.round(ratio * 1000) / 10).toFixed(1) + '%'
    }
    /** 成功率的排序 / 配色取值：null 表示没采样（排序恒定垫底、不参与配色） */
    function rateOf(r) {
      return isNum(r.okSamples) && isNum(r.samples) && r.samples > 0 ? r.okSamples / r.samples : null
    }
    /** 合法的并发上限：正整数；其余（空、0、非整数）都表示「没配，跟随默认」 */
    function validConc(v) {
      var n = Math.floor(Number(v))
      return isFinite(n) && n >= 1 ? n : null
    }

    /**
     * 拉看板数据。
     * @param {{since?: string, until?: string}} [range] - YYYY-MM-DD，按北京时间整天；
     *   省略即全部样本。筛选在 Host 侧做——汇总（成功率、分位数、token 合计）要按
     *   所选区间算，界面拿不到区间内的原始样本。
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
      /**
       * 看板排序：{ key, dir }；null = 默认序（分组名 → 优先级 → provider/model）。
       *
       * 初值取 status.metricsSort（Host 存在 settings.json 里），所以刷新页面、
       * 换个浏览器、甚至重启宿主后回到看板还是上次那个排序。status 是异步到的，
       * 由下面的 effect 补一次；用户已经点过表头（dirty）就不再覆盖。
       */
      var sortPair = React.useState(null); var sort = sortPair[0]; var setSort = sortPair[1]
      /** 用户是否已经自己点过表头：点过就不再让迟到的 status 覆盖排序 */
      var sortDirtyPair = React.useState(false); var sortDirty = sortDirtyPair[0]; var setSortDirty = sortDirtyPair[1]
      /** 重设路由优先级的起始序号（只对当前排序里「有采样」的模型生效） */
      var orderStartPair = React.useState('1'); var orderStart = orderStartPair[0]; var setOrderStart = orderStartPair[1]
      /** 重设优先级的目标分组；空串 = 用第一行所属分组（看板通常只展示一个分组） */
      var orderGroupPair = React.useState(''); var orderGroupId = orderGroupPair[0]; var setOrderGroupId = orderGroupPair[1]
      /** 测速进度（一键整组或单模型共用）：来自 GET /speedtest，null = 还没点过 */
      var speedTestPair = React.useState(null); var speedTest = speedTestPair[0]; var setSpeedTest = speedTestPair[1]
      /**
       * 本次测速覆盖了哪几行（provider/model 清单）。快照只给 done/total，
       * 不说当前测到谁；界面上的「测速中」靠这份本地清单标出来。
       */
      var speedScopePair = React.useState([]); var speedScope = speedScopePair[0]; var setSpeedScope = speedScopePair[1]
      /** 重设优先级 / 启动测速的操作回执：{ ok, text }，只保留最近一条 */
      var orderNoticePair = React.useState(null); var orderNotice = orderNoticePair[0]; var setOrderNotice = orderNoticePair[1]
      /** 看板日期筛选：{ since, until } 均为 YYYY-MM-DD（北京时间整天）；空串 = 不限 */
      var rangePair = React.useState({ since: '', until: '' })
      var range = rangePair[0]; var setRange = rangePair[1]
      /** 并发输入框的本地草稿（按模型 key），避免每敲一个字符就被轮询回写覆盖 */
      var concPair = React.useState({}); var concDraft = concPair[0]; var setConcDraft = concPair[1]
      /**
       * 默认并发输入框的本地草稿：null = 没在改，显示 Host 的生效值。
       * 不能直接绑生效值——看板每 3 秒轮询一次 /metrics，清空重打时会被顶回旧数字。
       */
      var defConcPair = React.useState(null); var defConcDraft = defConcPair[0]; var setDefConcDraft = defConcPair[1]

      /** 默认并发上限：status.defaultConcurrency 是面板级默认（对所有没单独设上限的模型生效） */
      var defaultConc = status && typeof status.defaultConcurrency === 'number' ? status.defaultConcurrency : null
      /** 界面上有没有覆盖默认并发：settings.defaultConcurrency 非 null 即覆盖过（0 也是有效值） */
      var defaultConcOverridden = !!(status && status.settings && typeof status.settings.defaultConcurrency === 'number')
      /** config 里的出厂值：清掉界面上的覆盖后回落到它 */
      var configDefaultConc = status && typeof status.configDefaultConcurrency === 'number' ? status.configDefaultConcurrency : null
      var defaultConcHint = defaultConc === null
        ? ''
        : (defaultConc === 0 ? '当前默认不限（0）' : '当前默认 ' + defaultConc)
          + (defaultConcOverridden ? '，在数据看板标题栏改' : '，来自 config，可在数据看板标题栏改')
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

      /**
       * 恢复上次的看板排序：status.settings.metricsSort 是 Host 落盘的值。
       * 只在用户还没自己点过表头时套用——否则一次慢到的 status 会把刚点的排序
       * 顶回旧的。sortDirty 一旦置位就不再复位，直到弹窗重新挂载。
       */
      React.useEffect(function () {
        if (sortDirty) return
        var saved = status && status.settings ? status.settings.metricsSort : null
        if (!saved || typeof saved.key !== 'string') return
        var dir = saved.dir === 'desc' ? 'desc' : 'asc'
        setSort(function (prev) {
          if (prev && prev.key === saved.key && prev.dir === dir) return prev
          return { key: saved.key, dir: dir }
        })
      }, [status, sortDirty])

      /**
       * 一键测速的进度轮询：只有任务在跑时才每 1.5 秒问一次 /speedtest，
       * 跑完就停（最后一次响应里 running=false，不再续定时器）。
       */
      React.useEffect(function () {
        if (!speedTest || !speedTest.running) return
        var t = setInterval(function () {
          apiGet(API + '/speedtest').then(function (d) {
            if (d) setSpeedTest(d)
          }).catch(function () { })
        }, 1500)
        return function () { clearInterval(t) }
      }, [speedTest && speedTest.running])

      /** 离开看板页签时清掉测速面板（任务本身在 Host 里跑，回来还能再问） */
      React.useEffect(function () {
        if (tab === 'dashboard') return
        setSpeedTest(null)
        setSpeedScope([])
      }, [tab])

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
      // 当日失败的详情（错误码 + 完整报错文案）：看板上悬停要看的就是它。
      // 单独的 map，不改 failedMap 的布尔语义——模型列表只关心「失败没失败」。
      var failedDetail = {}
      failedList.forEach(function (f) {
        failedDetail[keyOf(f.provider, f.model)] = { code: f.code || null, reason: f.reason || null }
      })
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
                  + '。达到上限时立刻切到组内其它空闲模型，不在闸门里排队；整组都满才等槽位释放。',
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
                  onBlur: function () { concBlur(k) },
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
       *
       * 每次点击都把结果写回 Host（settings.json 的 metricsSort），这样刷新页面
       * 或换浏览器回来还是这个排序。写失败不打断界面：本地状态已经生效，
       * 下次打开退回默认序而已。
       */
      function toggleSort(key) {
        var next
        if (!sort || sort.key !== key) next = { key: key, dir: 'asc' }
        else if (sort.dir === 'asc') next = { key: key, dir: 'desc' }
        else next = null
        setSortDirty(true)
        setSort(next)
        apiSend(API + '/settings', 'POST', { metricsSort: next }).catch(function () { })
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
       * 失焦即放弃本地草稿，输入框回到服务端记录的真实值。
       * 看板与「模型」页签共用同一个草稿 state，所以清除逻辑也共用这一份。
       */
      function concBlur(k) {
        var nxt = Object.assign({}, concDraft)
        delete nxt[k]
        setConcDraft(nxt)
      }

      /**
       * 默认并发上限（面板级）：POST /settings 的 defaultConcurrency。
       *
       * 与模型级并发不同，它作用于所有**没单独设上限**的模型；模型级那条永远优先。
       * 留空 = 清掉界面上的覆盖、回落到 config.defaultConcurrency；0 = 不限。
       *
       * 提交放在失焦/回车而不是每次敲键：数字框清空重打时会先经过一个空值，
       * 那个中间态若立刻提交，等于用户没说过的「清除覆盖」，还会触发一次全表刷新。
       */
      function commitDefaultConcurrency(raw) {
        var text = String(raw).trim()
        var payload = null
        if (text !== '') {
          var n = Number(text)
          if (!Number.isInteger(n) || n < 0 || n > 999) {
            setOrderNotice({ ok: false, text: '默认并发需为 0..999 的整数（0 = 不限），或留空跟随配置' })
            setDefConcDraft(null)
            return
          }
          payload = n
        }
        apiSend(API + '/settings', 'POST', { defaultConcurrency: payload })
          .then(function (r) {
            if (r && r.ok === false) {
              setOrderNotice({ ok: false, text: '默认并发保存失败：' + String(r.error || '未知原因') })
              setDefConcDraft(null)
              return null
            }
            setOrderNotice(null)
            setDefConcDraft(null)
            return refreshMetrics()
          })
          .catch(function (e) {
            setOrderNotice({ ok: false, text: '默认并发保存失败：' + String(e && e.message ? e.message : e) })
            setDefConcDraft(null)
          })
      }

      /**
       * 恢复一个模型的当日失败：/failed/reset 带 provider/model 时只清这一个模型，
       * 不会连带清掉其它分组里也在失败名单上的模型。看板与「失败模型」页签共用。
       */
      function restoreFailed(provider, model) {
        apiSend(API + '/failed/reset', 'POST', { provider: provider, model: model })
          .then(function () { return refreshMetrics() })
          .then(function () { return refreshStatus() })
      }

      /**
       * 看板操作条上的批量恢复：只清当前分组（分组下拉选的那个）里的失败模型。
       * 不带 body 的 /failed/reset 会清掉全天全部失败，跨了分组就是越权，所以这里
       * 逐个模型调。
       */
      function restoreFailedInScope(rows) {
        if (rows.length === 0) return
        setOrderNotice({ ok: true, text: '正在恢复 ' + rows.length + ' 个模型的失败状态…' })
        Promise.all(rows.map(function (r) {
          return apiSend(API + '/failed/reset', 'POST', { provider: r.provider, model: r.model })
        })).then(function () {
          setOrderNotice({ ok: true, text: '已恢复 ' + rows.length + ' 个模型，立即重新参与路由' })
          return refreshMetrics()
        }).then(function () { return refreshStatus() })
          .catch(function (e) {
            setOrderNotice({ ok: false, text: '恢复失败：' + String(e && e.message ? e.message : e) })
          })
      }

      /**
       * 从路由移除：把这个模型从所在分组的模型清单里摘掉，分组里其余模型与
       * 它们的优先级都不动。与「禁用」的区别：禁用留着条目、只是不参与路由；
       * 移除连条目一起删，想加回来得从「模型」页签重新 ＋。
       *
       * 看板一行对应一个分组（同一模型在两个分组里会有两行），所以只动这一行
       * 所属的分组；要让某个模型彻底离开路由，就把它所在的每一行都移除。
       */
      function removeFromRouting(provider, model, groupId) {
        var g = routeGroups.find(function (x) { return x.id === groupId })
        if (!g) { setOrderNotice({ ok: false, text: '分组信息已过期，刷新后再试' }); return }
        var models = g.models || []
        var rest = models.filter(function (m) { return !(m.provider === provider && m.model === model) })
        if (rest.length === models.length) return
        setOrderNotice({ ok: true, text: '正在把 ' + provider + '/' + model + ' 从「' + g.name + '」移除…' })
        apiSend(API + '/groups', 'PUT', { id: groupId, models: rest })
          .then(function (res) {
            if (res && res.ok) {
              setOrderNotice({ ok: true, text: '已从「' + g.name + '」移除 ' + provider + '/' + model })
              return refreshMetrics()
            }
            setOrderNotice({ ok: false, text: (res && res.error) || '移除失败' })
          })
          .then(function () { return refreshStatus() })
          .catch(function (e) {
            setOrderNotice({ ok: false, text: '移除失败：' + String(e && e.message ? e.message : e) })
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
            byKey[keyOf(gm[i].provider, gm[i].model)] = { groupName: g.name, priority: gm[i].priority, groupId: g.id }
          }
        })
        var items = rawRows.map(function (r) {
          var meta = byKey[keyOf(r.provider, r.model)] || {}
          return {
            row: r,
            groupName: r.groupName || meta.groupName || '',
            priority: typeof meta.priority === 'number' ? meta.priority : 99,
            // 这一行属于哪个分组：看板的「从路由移除」只动这一行所属的分组。
            // metrics 行自带 groupId；补不到时用分组目录里的记录兜底。
            groupId: r.groupId || meta.groupId || '',
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
        // 成功率按 ratio 排（不是按字符串），没样本的行垫底
        if (key === 'rate') return rateOf(r)
        if (key === 'ttft') return isNum(r.ttftP50) ? r.ttftP50 : null
        if (key === 'tps') return isNum(r.tpsP50) ? r.tpsP50 : null
        // token 列看的是「所选区间内的总量」（表格里的大字就是它），所以按同一个数
        // 排，而不是按历史总量——否则点这个表头排出来的序和肉眼看到的数不一致。
        if (key === 'tokens') return rangeTokensOf(r)
        // 并发列按「生效上限」排：不限（null）垫底，与显示一致
        if (key === 'conc') return Number.isInteger(r.concurrency) && r.concurrency > 0 ? r.concurrency : null
        return metricsStatusRank(r)
      }

      /**
       * 某行**所选区间内**的 token 总量（输入 + 输出，**含缓存命中**），
       * null = 区间内没有采样。
       *
       * Host 在同一批样本上算好区间内的合计（inTokens / outTokens /
       * cacheReadTokens / cacheWriteTokens），所以它跟着日期筛选走：筛到某一天，
       * 这个数就只算那一天的用量。
       *
       * DSH 的 usage 把缓存命中拆成 cacheReadTokens / cacheWriteTokens 单独报，
       * 它们是**输入**的一部分（billed input = 三者之和，见
       * packages/llm/llm/src/types.ts 的 TokenUsage 注释）。只加 inputTokens
       * 会把命中缓存的那部分整段丢掉，所以这里必须一并计入。
       */
      function rangeTokensOf(r) {
        // 区间内没有一条样本报了 usage，就当「没记」而不是「用了 0」：0 会被读成
        // 「这个模型今天确实没烧 token」，与「provider 不报 usage」是两件事。
        var tokenSamples = isNum(r.tokenSamples) ? r.tokenSamples : 0
        if (tokenSamples <= 0) return null
        var inT = isNum(r.inTokens) ? r.inTokens : 0
        var outT = isNum(r.outTokens) ? r.outTokens : 0
        var crT = isNum(r.cacheReadTokens) ? r.cacheReadTokens : 0
        var cwT = isNum(r.cacheWriteTokens) ? r.cacheWriteTokens : 0
        return inT + outT + crT + cwT
      }

      /**
       * 某行的历史 token 总量（输入 + 输出，**含缓存命中**），null = 一次 usage 都没报过。
       *
       * 「历史」指不随日期筛选变化的全量样本，由 Host 的 lifetime*Tokens 提供；
       * 旧版 Host 没有这些字段时回落到区间内的合计，至少不会一片空白。
       */
      function lifetimeTokensOf(r) {
        var inT = isNum(r.lifetimeInTokens) ? r.lifetimeInTokens : r.inTokens
        var outT = isNum(r.lifetimeOutTokens) ? r.lifetimeOutTokens : r.outTokens
        var crT = isNum(r.lifetimeCacheReadTokens) ? r.lifetimeCacheReadTokens : r.cacheReadTokens
        var cwT = isNum(r.lifetimeCacheWriteTokens) ? r.lifetimeCacheWriteTokens : r.cacheWriteTokens
        var hasIn = isNum(inT)
        var hasOut = isNum(outT)
        var hasCache = isNum(crT) || isNum(cwT)
        if (!hasIn && !hasOut && !hasCache) return null
        return (hasIn ? inT : 0) + (hasOut ? outT : 0) + (hasCache ? crT : 0) + (hasCache ? cwT : 0)
      }

      /** 某行历史输入里命中缓存的比例（0~1），null = 不知道 / 没有输入量 */
      function lifetimeCacheHitRatioOf(r) {
        var inT = isNum(r.lifetimeInTokens) ? r.lifetimeInTokens : r.inTokens
        var crT = isNum(r.lifetimeCacheReadTokens) ? r.lifetimeCacheReadTokens : r.cacheReadTokens
        var cwT = isNum(r.lifetimeCacheWriteTokens) ? r.lifetimeCacheWriteTokens : r.cacheWriteTokens
        if (!isNum(inT) || !isNum(crT) && !isNum(cwT)) return null
        var cacheT = isNum(crT) ? crT : 0
        var writeT = isNum(cwT) ? cwT : 0
        var billedInput = inT + cacheT + writeT
        if (billedInput <= 0) return null
        return (cacheT + writeT) / billedInput
      }

      /** 某行是否有任何采样（决定它是否参与「按当前排序重设优先级」） */
      function hasSamples(r) { return isNum(r.samples) && r.samples > 0 }

      /**
       * 这一行的错误详情：错误码 + 完整报错文案（悬停看）。
       *
       * 当日失败的模型优先用失败记录里的原因（那是「所有重试耗尽后」的最终结论），
       * 没有失败记录时用最近一次采样失败的信息。两处都没有就返回 null——
       * 与其显示一个空壳错误码，不如什么都不显示。
       */
      function errorDetailOf(r, k) {
        var det = failedDetail[k]
        var code = null
        var message = null
        var source = null
        if (det && det.code) {
          code = String(det.code)
          message = det.reason ? String(det.reason) : null
          source = '当日失败记录'
        } else if (r.lastErrorCode) {
          code = String(r.lastErrorCode)
          message = r.lastErrorMessage ? String(r.lastErrorMessage) : null
          source = '最近一次采样失败'
        }
        if (!code) return null
        var title = source + '：' + code
        if (message) title += '\n\n' + message
        return { code: code, message: message, source: source, title: title }
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
        var defaultHint = defConc === null ? '' : (defConc === 0 ? '当前默认不限（0）' : '当前默认 ' + defConc)

        // ---- 「按当前排序重设优先级」与「一键测速」共用的一份目标清单 ----
        //
        // 看板一次展示所有分组，而优先级是分组内的属性：重设必须落到某一个分组上。
        // 由上面的分组下拉选择；缺省取排序后第一行所属分组（最常见的用法：看板里
        // 就一个分组）。samplesOf 决定「有没有数据」——没有采样的模型被排除，
        // 既不参与重排、也不重置它的优先级。
        var groupOptions = []
        var seenGroup = {}
        sorted.forEach(function (it) {
          var gid = it.row.groupId
          if (!gid || seenGroup[gid]) return
          seenGroup[gid] = true
          groupOptions.push({ id: gid, name: it.groupName || gid })
        })
        var effOrderGroupId = orderGroupId || (groupOptions.length > 0 ? groupOptions[0].id : '')
        // 有采样且属于目标分组、且没被手动禁用的行：按当前排序的先后顺序
        var orderTargets = sorted.filter(function (it) {
          return it.row.groupId === effOrderGroupId && hasSamples(it.row) && it.row.disabled !== true
        }).map(function (it) { return it.row })
        // 测速目标：同样只测有数据之外也要测——「一键测速」的价值恰恰在于给
        // 还没采样的模型补数据，所以这里不按 samples 过滤，只排除已禁用的。
        var speedTargets = sorted.filter(function (it) {
          return it.row.groupId === effOrderGroupId && it.row.disabled !== true
        }).map(function (it) { return it.row })
        // 当前分组里当日失败的行：操作条上的批量「恢复」只清这些模型。
        // 不带 body 的 /failed/reset 会清掉全天全部失败，跨了分组就是越权。
        var failedInScope = sorted.filter(function (it) {
          return it.row.groupId === effOrderGroupId && it.row.failed === true
        }).map(function (it) { return it.row })

        /**
         * 按当前排序重设优先级：把 orderTargets 的先后顺序写回 priority。
         * 起始序号由输入框给，缺省 1；Host 侧再校验一次（1..999）。
         */
        function applyReorderPriority() {
          var start = parseInt(String(orderStart).trim(), 10)
          if (!isFinite(start) || start < 1 || start > 999) {
            setOrderNotice({ ok: false, text: '起始序号需为 1..999 的整数' })
            return
          }
          if (!effOrderGroupId) { setOrderNotice({ ok: false, text: '先选一个分组' }); return }
          if (orderTargets.length === 0) {
            setOrderNotice({ ok: false, text: '当前分组里没有带采样的模型，无法按排序重设' })
            return
          }
          setOrderNotice({ ok: true, text: '正在重设 ' + orderTargets.length + ' 个模型的优先级…' })
          apiSend(API + '/groups/reorder-priority', 'POST', {
            groupId: effOrderGroupId,
            start: start,
            order: orderTargets.map(function (r) { return { provider: r.provider, model: r.model } }),
          }).then(function (res) {
            if (res && res.ok) {
              setOrderNotice({ ok: true, text: '已按当前排序重设 ' + res.applied + ' 个模型的优先级（' + res.start + ' 起）' })
              return refreshMetrics()
            }
            setOrderNotice({ ok: false, text: (res && res.error) || '重设失败' })
          }).catch(function (e) {
            setOrderNotice({ ok: false, text: '重设失败：' + String(e && e.message ? e.message : e) })
          })
        }

        /**
         * 发起一次测速。`rows` 可以是一整组，也可以只是看板上的某一行——
         * Host 的 POST /speedtest 收的都是 models 清单，两条路径共用同一份进度。
         * 立刻返回任务快照，进度由上面的 effect 轮询 GET /speedtest 推进。
         *
         * speedScope 是本地的「这次测了哪几行」：Host 的快照只说 done/total，
         * 不说当前测到谁，界面上的「测速中」只能靠这份清单标出来。旧 Host 没有
         * targets 字段时，它是唯一依据。
         */
        function launchSpeedTest(rows) {
          if (rows.length === 0) {
            setOrderNotice({ ok: false, text: '没有可测速的模型（都被禁用了？）' })
            return
          }
          setSpeedScope(rows.map(function (r) { return keyOf(r.provider, r.model) }))
          setSpeedTest({
            running: true, startedAt: Date.now(), finishedAt: null,
            total: rows.length, done: 0, results: [],
          })
          apiSend(API + '/speedtest', 'POST', {
            models: rows.map(function (r) {
              return { provider: r.provider, model: r.model, effort: r.effort || undefined }
            }),
          }).then(function (res) {
            if (res) setSpeedTest(res)
            if (!res || res.ok === false) {
              setOrderNotice({ ok: false, text: (res && res.error) || '测速启动失败' })
            }
          }).catch(function (e) {
            setSpeedTest(null)
            setOrderNotice({ ok: false, text: '测速启动失败：' + String(e && e.message ? e.message : e) })
          })
        }

        /** 一键测速：目标分组里所有未禁用的模型 */
        function startSpeedTest() {
          if (speedTargets.length === 0) {
            setOrderNotice({ ok: false, text: '当前分组里没有可测速的模型（都被禁用了？）' })
            return
          }
          launchSpeedTest(speedTargets)
        }

        /**
         * 单模型测速：只测这一行，不受「属于当前分组」「有没有采样」「是否被禁用」
         * 限制——想单独点某一行的场景恰恰是排查一个可疑模型，禁用中的也要能测。
         */
        function startRowSpeedTest(r) {
          launchSpeedTest([r])
        }

        /** 测速结果按 provider/model 索引，行内直接标出本次实测值 */
        var probeByKey = {}
        if (speedTest && speedTest.results) {
          speedTest.results.forEach(function (p) { if (p) probeByKey[keyOf(p.provider, p.model)] = p })
        }
        // 本次任务覆盖的行：本地 scope 优先（点了哪几行最准），旧 Host 的快照里
        // 没有 targets 时用它；两边都有则以本地为准。
        var runningKeys = {}
        if (speedTest && speedTest.running) {
          var scopeKeys = speedScope.length > 0
            ? speedScope
            : (speedTest.targets || []).map(function (t) { return keyOf(t.provider, t.model) })
          scopeKeys.forEach(function (k) { if (!probeByKey[k]) runningKeys[k] = true })
        }


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
            // 默认并发：直接在这里改（存 Host 的 settings.json，所有没单独设上限的
            // 模型立即跟着变）。留空 = 清掉覆盖、回落到 config 的出厂值。
            e('span', { style: { fontSize: '11px', opacity: .6, display: 'flex', alignItems: 'center', gap: '4px' } },
              e('span', { title: '默认并发上限：所有没有单独设置上限的模型都按它算' }, '默认并发'),
              e('input', {
                type: 'number', min: 0, max: 999, step: 1,
                style: Object.assign({}, S.modelConcInput, { width: '52px' }),
                value: defConcDraft !== null ? defConcDraft : (defConc === null ? '' : String(defConc)),
                placeholder: '不限',
                'aria-label': '默认并发上限',
                title: '默认并发上限：所有没单独设上限的模型都按它算。0 = 不限；'
                  + '留空 = 清除这里的设置、跟随 config 的出厂值'
                  + (configDefaultConc === null ? '' : '（config 里是 ' + (configDefaultConc === 0 ? '不限' : configDefaultConc) + '）')
                  + '。单独设过上限的模型不受影响。改完失焦或回车生效。',
                onChange: function (ev) { setDefConcDraft(ev.target.value) },
                onBlur: function (ev) { commitDefaultConcurrency(ev.target.value) },
                onKeyDown: function (ev) { if (ev.key === 'Enter') ev.target.blur() },
              }),
              defaultConcOverridden
                ? e('span', { style: { fontSize: '10px', opacity: .45 }, title: '界面上设过默认并发；清空输入框即回落 config 的出厂值' }, '已设置')
                : e('span', { style: { fontSize: '10px', opacity: .45 }, title: '当前跟随 config.defaultConcurrency' }, '跟随配置')),
            metrics && isNum(metrics.sampledAt) && e('span', { style: { fontSize: '11px', opacity: .5 } },
              '采样于 ' + new Date(metrics.sampledAt).toLocaleTimeString()),
            e('span', { style: { marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' } },
              e('button', {
                style: S.btn,
                onClick: function () { refreshMetrics() },
              }, '刷新'))),
          // 日期筛选：按北京时间整天。筛选在 Host 侧做（区间内的分位数与合计要在
          // 同一批样本上算，不能在界面里二次切分）。快捷区间覆盖最常用的三种看法。
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
            '成功率 = 区间内成功调用 / 区间内全部采样（历史全部保留，不按条数截断）；'
            + '首字 = 请求发出到第一个输出增量的时间；速度 = 输出 token / 生成耗时（大字是区间中位数 P50，'
            + '小字是该模型活跃并发区间内的合计速度——这批在跑请求从最早开始产出的那一刻算到现在，总输出字符 ÷ 4 ÷ 区间秒数）；'
            + 'token = 所选区间内该模型的输入/输出/缓存用量合计（只统计适配器报了 usage 的调用）；'
            + '并发 = 正在进行的请求 / 生效上限（模型自己的上限直接在「并发」列改，按模型持久化、对所有分组统一生效；'
            + '没单独设上限的模型跟随标题栏的「默认并发」，那里改一次就全表生效；达到上限时立刻换组内其它模型，不排队）。'),
          e('div', { style: S.metricsNote },
            '副行灰字是该列的补充：成功率给成功数 / 采样数，首字给 P90，速度给活跃区间合计速度（没请求在产出时不显示），'
            + 'token 一行一个数给输入 / 缓存命中 / 缓存写入 / 输出（鼠标悬停大字看历史总量），'
            + '并发给等槽时间与等槽位数（闸门里不排队，只有整组都满时才有人等），模型给所属分组。'
            + '模型行的「移除」把这个模型从它所属分组里摘掉；当日失败的行点状态列的「恢复」立即重新参与路由。'
            + '采样与 token 用量会落盘，重启后仍在。'),
          noneSampled && e('div', { style: S.hint }, '还没有采样：跑一次会话后这里会出现首字与速度数据。'),
          metrics === null && e('div', { style: S.hint }, '正在读取采样数据…'),
          metrics !== null && rows.length === 0 && e('div', { style: S.hint }, '分组里还没有模型。'),

          // 操作条：把「看着这个顺序顺眼，就照它排路由」和「这些模型现在到底通不通」
          // 两件看板上最常用的动作放在表格正上方，不用再翻分组页签。
          rows.length > 0 && e('div', { style: S.metricsActions },
            e('span', { style: { fontSize: '11px', opacity: .6, flexShrink: 0 } }, '分组'),
            groupOptions.length > 1
              ? e('select', {
                style: S.metricsDate,
                value: effOrderGroupId,
                title: '重设优先级、一键测速与批量恢复都作用于这个分组',
                onChange: function (ev) { setOrderGroupId(ev.target.value) },
              }, groupOptions.map(function (g) {
                return e('option', { key: g.id, value: g.id }, g.name)
              }))
              : e('span', { style: { fontSize: '11px', opacity: .8 } },
                groupOptions.length === 1 ? groupOptions[0].name : '—'),
            e('span', { style: { opacity: .3, fontSize: '11px' } }, '|'),
            e('span', {
              style: { fontSize: '11px', opacity: .6, flexShrink: 0 },
              title: '重设优先级时从这个序号开始，依次加一',
            }, '起始优先级'),
            e('input', {
              type: 'number', min: 1, max: 999, step: 1,
              style: Object.assign({}, S.metricsDate, { width: '58px' }),
              value: orderStart,
              title: '1..999；当前排序里有采样的模型从它开始依次占用',
              onChange: function (ev) { setOrderStart(ev.target.value) },
            }),
            e('button', {
              style: S.btn,
              disabled: orderTargets.length === 0,
              title: orderTargets.length === 0
                ? '当前分组里没有带采样的模型，先跑一次会话或点右侧「一键测速」'
                : '按看板当前排序，把 ' + orderTargets.length + ' 个有数据的模型的优先级从 '
                  + (orderStart || '1') + ' 起依次重排（无数据的模型保持原优先级）',
              onClick: applyReorderPriority,
            }, '按当前排序重设优先级'),
            e('span', { style: { fontSize: '10px', opacity: .45 } },
              orderTargets.length > 0 ? orderTargets.length + ' 个有数据' : '无带数据模型'),
            e('span', { style: { opacity: .3, fontSize: '11px' } }, '|'),
            e('button', {
              style: S.btn,
              disabled: failedInScope.length === 0,
              title: failedInScope.length === 0
                ? '当前分组里没有当日失败的模型'
                : '把当前分组里 ' + failedInScope.length + ' 个当日失败的模型立即恢复参与路由'
                  + '（逐个清除，只清这些模型，其它分组的失败记录不受影响）',
              onClick: function () { restoreFailedInScope(failedInScope) },
            }, failedInScope.length > 0 ? '恢复本组失败 (' + failedInScope.length + ')' : '本组无失败'),
            e('span', { style: { marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' } },
              speedTest && speedTest.running && e('span', { style: { fontSize: '11px', opacity: .7 } },
                '测速中 ' + (speedTest.done || 0) + '/' + (speedTest.total || 0)),
              speedTest && !speedTest.running && e('span', { style: { fontSize: '11px', opacity: .6 } },
                '测速完成 '
                + (speedTest.results || []).filter(function (p) { return p && p.ok }).length
                + '/' + (speedTest.total || 0)),
              e('button', {
                style: S.btn,
                disabled: !!(speedTest && speedTest.running),
                title: '对当前分组里未禁用的模型各发一次最小请求，实测首字延迟与输出速度（结果同时进入采样）',
                onClick: startSpeedTest,
              }, speedTest && speedTest.running ? '测速进行中…' : '一键测速'))),
          orderNotice && e('div', {
            style: {
              fontSize: '11px', padding: '0 2px 6px',
              color: orderNotice.ok ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-warn-label)',
            },
          }, orderNotice.text),

          rows.length > 0 && e('div', { style: S.metricsTable },
            e('div', { style: Object.assign({}, S.metricsRow, S.metricsRowHead) },
              sortHead('model', '模型', false),
              sortHead('rate', '成功率', true),
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
              // 速度：主行是区间 P50（这个模型平时多快），副行是**当前这批活跃请求在
              // 同一个区间里合起来**多快。两者回答的不是同一个问题——前者用来挑模型，
              // 后者用来看这条链路此刻被占了多少；并发上来时副行会明显大于主行。
              // 区间起点取这批请求里最早吐首字的那一刻，因此刚起步的请求不会被算成
              // 一个虚高的瞬时速率，长跑请求也不会把它的历史平均摊进来。
              // 实时读数拿不到真实 token（usage 在流末尾才到），按字符估，故只在
              // 有请求在产出时显示；流一结束副行就消失，改由下一次采样的 P50 反映。
              function speedCell(r) {
                var live = isNum(r.aggregateTps) ? r.aggregateTps : null
                var running = isNum(r.inflight) ? r.inflight : 0
                var sub = null
                if (live !== null) {
                  sub = e('span', {
                    style: S.metricsNumSub,
                    title: '活跃区间合计速度：这个模型此刻 ' + running + ' 个在跑请求，从最早开始产出的那一刻起算，加起来约 '
                      + fmtTps(live) + '\n算法：区间内所有请求的输出（含思考与工具参数）字符数 ÷ 4 ÷ 区间秒数，'
                      + '1 token ≈ 4 字符；请求结束后以适配器报的 usage 计入区间样本',
                  }, '活跃 ' + fmtTps(live))
                } else if (running > 0) {
                  // 在跑但还没有任何输出增量：此时速率为 0，但那是「还在等第一个字」，
                  // 不是「卡住了」，所以写清楚在等，而不是压一个 0.0。
                  sub = e('span', {
                    style: S.metricsNumSub,
                    title: '这张表每 3 秒刷新一次，此刻这 ' + running + ' 个请求还没吐出第一个字，所以还没有可算的区间',
                  }, '活跃 等首字')
                }
                return e('div', { style: S.metricsNumCell },
                  e('span', {
                    style: S.metricsNumMain,
                    title: '区间内的输出速度中位数（P50）：输出 token / 生成耗时，只算已完成并报了 usage 的调用'
                      + '\nP90 ' + fmtTps(r.tpsP90),
                  }, fmtTps(r.tpsP50)),
                  sub)
              }
              // 并发副行：等槽时间优先，其次等槽位数；都没有就不画
              var concSub = isNum(r.waitP50) && r.waitP50 > 0 ? '等槽 ' + fmtMs(r.waitP50) : null
              var queueSub = queued > 0 ? '等槽位 ' + queued : null
              var concSubText = [concSub, queueSub].filter(Boolean).join(' · ')
              return e('div', { key: k, style: style },
                // 模型列允许折行：provider/model 再长也看全，title 兜底完整值
                e('div', { style: S.metricsCellModel },
                  e('div', {
                    style: S.metricsModel,
                    title: r.provider + '/' + r.model + (it.groupName ? '\n分组：' + it.groupName : ''),
                  }, r.provider + '/' + r.model),
                  e('div', { style: S.metricsSubLine },
                    e('span', {
                      style: S.metricsSubText,
                      title: it.groupName ? '所属分组：' + it.groupName : '这个模型还没进任何分组',
                    }, it.groupName ? it.groupName : '未分组'),
                    // 从路由移除：这一行属于哪个分组就从哪个分组里摘掉它。
                    // 同一模型在两个分组里会有两行，要彻底离开路由就两行都移除。
                    it.groupId && e('button', {
                      style: S.metricsMiniBtn,
                      title: '把 ' + r.provider + '/' + r.model + ' 从「' + (it.groupName || '分组')
                        + '」移除：不再参与路由，分组里其它模型与优先级不变（想加回来从「模型」页签重新 ＋）',
                      onClick: function () { removeFromRouting(r.provider, r.model, it.groupId) },
                    }, '移除'),
                    // 单模型测速：整组测一次要打十几个请求，只想确认某一个模型时
                    // 不该等整批。Host 同一时刻只跑一个任务，所以任务进行中整列
                    // 按钮都按住（包括这一行自己）。
                    e('button', {
                      style: S.metricsProbeBtn,
                      disabled: !!(speedTest && speedTest.running),
                      title: (speedTest && speedTest.running)
                        ? '已有测速在跑，等它结束（Host 同一时刻只跑一个，并发打上游会把账号池测成排队时间）'
                        : '只测这一个模型：发一次最小请求，实测首字延迟与输出速度。'
                          + '不受当前分组限制，禁用中的模型也能测（用来确认它是不是真挂了）',
                      onClick: function () { startRowSpeedTest(r) },
                    }, runningKeys[k] ? '测速中' : '测速')),
                  // 一键测速的本次实测结果：贴在模型名下，与看板的历史聚合值区分开。
                  // 失败只标错误码，不占一整行——表格里最要紧的是「通 / 不通」。
                  (function () {
                    var p = probeByKey[k]
                    if (!p) return null
                    return e('div', {
                      style: Object.assign({}, S.metricsSub, { opacity: .85 },
                        p.ok ? {} : { color: 'var(--dsw-alias-state-warn-label)' }),
                      title: p.ok
                        ? '本次测速：首字 ' + fmtMs(p.ttftMs) + '，速度 ' + fmtTps(p.tps)
                          + (isNum(p.outTokens) ? '，输出 ' + p.outTokens + ' tok' : '')
                        : '本次测速失败：' + (p.errorCode || 'ERROR') + (p.error ? '（' + p.error + '）' : ''),
                    }, p.ok
                      ? '测速 ' + fmtMs(p.ttftMs) + ' · ' + fmtTps(p.tps)
                      : '测速失败 ' + (p.errorCode || 'ERROR'))
                  })()),
                // 成功率：主行百分比、副行「成功数/采样数」。没样本（分母 0）两行都写 —，
                // 不显示 0%——0% 会被读成「全都失败」，与「还没打过」是两回事。
                (function () {
                  var ratio = rateOf(r)
                  var rateText = fmtRate(r.okSamples, r.samples)
                  // 样本太少时不下颜色判断：2 条里错 1 条不该红一整行
                  var enough = isNum(r.samples) && r.samples >= 5
                  var warn = ratio !== null && enough && ratio < 0.9
                  return e('div', { style: S.metricsNumCell },
                    e('span', {
                      style: Object.assign({}, S.metricsNumMain,
                        warn ? { color: 'var(--dsw-alias-state-warn-label)', fontWeight: 600 } : {}),
                      title: '成功率 = 成功调用 / 采样数（区间内全部采样，不限条数）'
                        + (isNum(r.okSamples) && isNum(r.samples) ? '\n' + r.okSamples + ' 成功 / ' + r.samples + ' 次' : ''),
                    }, rateText === null ? '—' : rateText),
                    rateText !== null && e('span', {
                      style: S.metricsNumSub,
                      title: '成功数 / 采样数',
                    }, (isNum(r.okSamples) ? r.okSamples : 0) + '/' + (isNum(r.samples) ? r.samples : 0)))
                })(),
                p90Cell(r.ttftP50, r.ttftP90, fmtMs),
                speedCell(r),
                // token：大字是**所选区间内**的总量（输入 + 输出，含缓存命中），
                // 跟着日期筛选走——筛到某一天，这个数就只算那一天。副行把拆分
                // 摊成一行一个数：命中缓存是省钱的关键信号，挤在一行里会被
                // 省略号吃掉。历史总量放进 title，供「这个模型一共烧了多少」用。
                (function () {
                  var rangeTotal = rangeTokensOf(r)
                  var rangeIn = isNum(r.inTokens) ? r.inTokens : null
                  var rangeOut = isNum(r.outTokens) ? r.outTokens : null
                  var rangeRead = isNum(r.cacheReadTokens) ? r.cacheReadTokens : null
                  var rangeWrite = isNum(r.cacheWriteTokens) ? r.cacheWriteTokens : null
                  var lifetimeTotal = lifetimeTokensOf(r)
                  var lifetimeIn = isNum(r.lifetimeInTokens) ? r.lifetimeInTokens : r.inTokens
                  var lifetimeOut = isNum(r.lifetimeOutTokens) ? r.lifetimeOutTokens : r.outTokens
                  var lifetimeRead = isNum(r.lifetimeCacheReadTokens) ? r.lifetimeCacheReadTokens : r.cacheReadTokens
                  var lifetimeWrite = isNum(r.lifetimeCacheWriteTokens) ? r.lifetimeCacheWriteTokens : r.cacheWriteTokens
                  var tokenSamples = isNum(r.lifetimeTokenSamples) ? r.lifetimeTokenSamples : r.tokenSamples
                  var cacheHitRatio = lifetimeCacheHitRatioOf(r)
                  // 一行一个数：小字按「输入 / 缓存命中 / 缓存写入 / 输出」排。
                  var split = []
                  if (isNum(rangeIn) && rangeIn > 0) split.push({ label: '↑输入', value: rangeIn })
                  if (isNum(rangeRead) && rangeRead > 0) split.push({ label: '缓存命中', value: rangeRead })
                  if (isNum(rangeWrite) && rangeWrite > 0) split.push({ label: '缓存写入', value: rangeWrite })
                  if (isNum(rangeOut) && rangeOut > 0) split.push({ label: '↓输出', value: rangeOut })
                  var cacheTitle = cacheHitRatio !== null
                    ? '\n历史缓存命中率：' + Math.round(cacheHitRatio * 100) + '%（'
                      + (isNum(lifetimeRead) ? fmtTokens(lifetimeRead) : '0') + ' 命中 / '
                      + (isNum(lifetimeWrite) ? fmtTokens(lifetimeWrite) : '0') + ' 写入）'
                    : ''
                  return e('div', { style: S.metricsNumCell },
                    e('span', {
                      style: Object.assign({}, S.metricsNumMain, S.metricsNumBig),
                      title: '所选区间内的 token 总量（输入 + 输出，含缓存命中）：'
                        + (rangeTotal === null ? '—' : fmtTokens(rangeTotal))
                        + '\n区间内输入 ' + (isNum(rangeIn) ? fmtTokens(rangeIn) : '—')
                        + ' / 缓存命中 ' + (isNum(rangeRead) ? fmtTokens(rangeRead) : '—')
                        + ' / 缓存写入 ' + (isNum(rangeWrite) ? fmtTokens(rangeWrite) : '—')
                        + ' / 输出 ' + (isNum(rangeOut) ? fmtTokens(rangeOut) : '—')
                        + '\n历史总量（全部样本）：' + (lifetimeTotal === null ? '—' : fmtTokens(lifetimeTotal))
                        + '\n历史输入 ' + (isNum(lifetimeIn) ? fmtTokens(lifetimeIn) : '—')
                        + ' / 缓存命中 ' + (isNum(lifetimeRead) ? fmtTokens(lifetimeRead) : '—')
                        + ' / 缓存写入 ' + (isNum(lifetimeWrite) ? fmtTokens(lifetimeWrite) : '—')
                        + ' / 输出 ' + (isNum(lifetimeOut) ? fmtTokens(lifetimeOut) : '—')
                        + cacheTitle
                        + (isNum(tokenSamples) ? '\n有 token 数据的样本：' + tokenSamples + ' / ' + (isNum(r.samples) ? r.samples : 0) : ''),
                    }, rangeTotal === null ? '—' : fmtTokens(rangeTotal)),
                    split.map(function (part, idx) {
                      return e('span', {
                        key: part.label,
                        style: S.metricsNumSub,
                        title: '区间内' + part.label + ' token：' + fmtTokens(part.value),
                      }, part.label + ' ' + fmtTokens(part.value))
                    }))
                })(),
                // 并发：两行。上行是上限输入框（与「模型」页签同一份提交逻辑，按模型
                // 持久化、对所有分组统一生效），下行是「进行中 / 生效上限」加等槽时间
                // 与等槽位数。这一格装两个独立事实——可编辑的上限、实时的进行中数——并排
                // 会让后者被压成省略号，而它正是要看的那一个。没配上限（跟随默认，
                // 默认也是不限）的行写成「N（不限）」：进行中照常计数，不限的只是上限。
                e('div', { style: S.metricsNumCell },
                  e('span', { style: S.metricsConcEdit },
                    e('input', {
                      type: 'number', min: 1, max: 999, style: S.metricsConcInput,
                      value: concDraft[k] !== undefined
                        ? concDraft[k]
                        : (explicit === null ? '' : String(explicit)),
                      placeholder: defaultConcText(),
                      'aria-label': '并发上限',
                      title: '并发上限：正整数即写死（对所有分组统一生效）；留空或 0 = 跟随默认上限'
                        + (defaultHint ? '（' + defaultHint + '，在数据看板标题栏改）' : '')
                        + '\n当前进行中：' + inflight + (effConc === null ? '（不限上限）' : ' / 上限 ' + effConc)
                        + (queued > 0 ? '\n等槽位：' + queued : '')
                        + '。达到上限时立刻切到组内其它空闲模型，不在闸门里排队；整组都满才等槽位释放',
                      onChange: function (ev) { commitConcurrency(r.provider, r.model, ev.target.value) },
                      onBlur: function () { concBlur(k) },
                    })),
                  e('span', {
                    style: S.metricsConcSub,
                    title: '当前进行中：' + fmtInflight(inflight, effConc)
                      + (concSubText ? '（' + concSubText + '）' : ''),
                  }, concSubText ? fmtInflight(inflight, effConc) + ' · ' + concSubText
                    : fmtInflight(inflight, effConc))),
                // 状态：主行一个标签（失败 > 禁用 > 冷却 > 正常，只画最严重的那个，
                // 避免一格里堆三枚胶囊把列撑爆），副行给错误码 + 「恢复」按钮。
                // 错误码一直要看得见（用户要判断「是不是同一个错」），完整报错
                // 放在 title 里——悬停就能看到上游到底说了什么，不必去「失败模型」
                // 页签翻。
                // 「恢复」按钮紧跟在状态标签后面（同一行），错误码独占副行：
                // 挤在一行会让错误码被按钮压成省略号。
                e('div', { style: S.metricsTagCell },
                  e('div', { style: S.metricsTagLine },
                    r.failed
                      ? e('span', {
                        style: S.tag,
                        title: '当日失败：不参与路由，日界线或成功一轮后自动恢复',
                      }, '当日失败')
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
                    r.failed && e('button', {
                      style: S.metricsMiniBtn,
                      title: '恢复这个模型的失败状态（立即重新参与路由；只清这一个模型）',
                      onClick: function () { restoreFailed(r.provider, r.model) },
                    }, '恢复')),
                  (function () {
                    var det = errorDetailOf(r, k)
                    return det
                      ? e('span', { style: S.metricsErrCode, title: det.title }, det.code)
                      : null
                  })()))
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
