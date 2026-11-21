/**
 * Stable entry shim for the QQ bot bridge.
 *
 * The implementation lives in `impl.js` and is imported with a cache-busting
 * query so that re-activating the plugin (disable then enable in the Plugin
 * Manager) loads the current file from disk instead of a module generation the
 * process imported earlier. That keeps iteration possible without restarting
 * the Harness.
 *
 * @module @local/dsh-qq-bot
 */

/** Services that must exist before the bridge can start. */
export const inject = ['agents', 'sessions']

export async function apply(ctx, config) {
  const url = new URL(`./impl.js?t=${Date.now()}`, import.meta.url)
  const module = await import(url.href)
  await module.apply(ctx, config)
}
