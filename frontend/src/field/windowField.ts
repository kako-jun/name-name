/**
 * `window.field`（検証用の読み取り口）の後始末。
 * 自分が置いたもの（`window.field === api`）だけ消す。後から起動した別のフィールドのものは残す
 */
export function clearWindowField(api: object): void {
  const w = window as unknown as { field?: unknown }
  if (w.field === api) delete w.field
}
