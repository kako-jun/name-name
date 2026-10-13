/**
 * キー入力の共通ガード (#204)。純粋関数のみ（PixiJS に触れない）。
 * フィールド（RaycastRenderer）と戦闘画面（BattleScreen）が同じ判定を使う。
 */

/** フォーム部品（入力・選択・編集可能領域）か。矢印キーなどをゲーム側で奪ってはいけない対象 */
export function isEditableTarget(el: EventTarget | Element | null | undefined): boolean {
  if (!el) return false
  const e = el as HTMLElement
  const tag = typeof e.tagName === 'string' ? e.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (e.isContentEditable === true) return true
  // jsdom など isContentEditable を持たない環境のための属性判定
  const attr = typeof e.getAttribute === 'function' ? e.getAttribute('contenteditable') : null
  return attr === '' || attr === 'true' || attr === 'plaintext-only'
}

/** 設定オーバーレイ（SettingsOverlay、Ctrl+,）が開いているか。開いている間は戦闘のキー操作を無視する */
export function isSettingsOverlayOpen(doc: Document | undefined = globalThis.document): boolean {
  if (!doc || typeof doc.querySelector !== 'function') return false
  return doc.querySelector('[role="dialog"][aria-label="設定"]') !== null
}

/**
 * 戦闘開始の時点で押されていたキー（`held`）は、一度 keyup されるまで無視する（エンカウント直後の誤爆防止）。
 * `held` に含まれるキーなら true（= 無視する）。
 */
export function isHeldKeyBlocked(held: ReadonlySet<string>, key: string): boolean {
  return held.has(key)
}
