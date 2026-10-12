/**
 * 压缩引擎入口，供 preset 层引用：`dsh-compact-codex/preset`。
 *
 * 为什么引擎走子路径而不是裸包名：`dsh-client-modules` 只扫**宿主树的 Loader 条目**，
 * 而 `exactPackageSpecifier` 对含 `/` 的 specifier 返回 undefined。preset 层用子路径，
 * 这行就不会参与客户端扫描；宿主层用裸包名挂一个空载体，让本包的 `dsh.client` 声明
 * 被扫进浏览器启动图。两者因此不构成"同一个包的两个 source"。
 *
 * 如果 preset 层继续用裸包名，宿主层再挂同一包，客户端模块系统会把它判为组合冲突。
 *
 * @module dsh-compact-codex/preset
 */

export { CodexCompactionEngine as default } from './index.js'
