/**
 * dsh-sidebar-scroller-compat，宿主半。
 *
 * 本插件只补浏览器侧的插槽 props 转发，宿主侧没有配置、路由或工具，
 * 所以这一行是空实现——它存在的意义只是让 Loader 有一个可加载的入口
 * （条目名解析到包的 main），并由 `dsh.client` 声明带出浏览器半。
 */

/** 空实现：条目激活即完成。 */
export function apply() {}
