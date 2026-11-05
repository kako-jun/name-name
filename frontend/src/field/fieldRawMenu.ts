/**
 * `buildFieldRaw` のうちメニュー (`[メニュー]` / `[メニュー項目]`) の部分 (#1127 / 親 #1096 S3d)。純関数。
 *
 * 規則(設計 §2-D):
 * 1. `[メニュー]` が無ければメニューなし。裸の `[メニュー]`(項目名なし)は既定の項目を全部並べる
 * 2. 項目名は 既定の ID → 既定のラベル → `[メニュー項目 <名>]` で宣言された ID の順に解決する。解決できない名・並びで重複した名は省いて警告
 * 3. `[メニュー項目]` の上書き(ラベル・無効・理由・時間制限・中身)を、並んだ項目に当てる。並びに無い ID の上書きは警告
 * 4. 既定に無い ID はラベルが無いと省く(`parseFieldMenuConfig` は label 必須)
 */
import { DEFAULT_FIELD_MENU_ITEMS } from '../game/fieldMenu'
import { hasOwn, safeAssign } from '../game/ownProperty'
import type { FieldMenuData, FieldMenuItemData } from '../types'
import type { FieldSceneNotation } from './fieldNotation'

type Raw = Record<string, unknown>

export function buildMenuRaw(
  menu: FieldMenuData | undefined,
  menuItems: readonly FieldMenuItemData[],
  scenes: readonly FieldSceneNotation[],
  contents: Readonly<Record<string, unknown>> | undefined,
  warnings: string[]
): Raw | undefined {
  if (menu === undefined) {
    for (const o of menuItems)
      warnings.push(`[メニュー項目 ${o.id}] は [メニュー] が無いので使われません`)
    return undefined
  }
  const declared = new Map(menuItems.map((o) => [o.id, o]))
  const names =
    menu.items && menu.items.length > 0 ? menu.items : DEFAULT_FIELD_MENU_ITEMS.map((d) => d.id)
  const items: Raw[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const def =
      DEFAULT_FIELD_MENU_ITEMS.find((d) => d.id === name) ??
      DEFAULT_FIELD_MENU_ITEMS.find((d) => d.label === name)
    if (!def && !declared.has(name)) {
      warnings.push(`[メニュー] の項目 '${name}' はメニューにありません（この項目は省きます）`)
      continue
    }
    const id = def ? def.id : name
    if (seen.has(id)) {
      warnings.push(`[メニュー] の項目 '${name}' は既に並んでいます（2 つ目は省きます）`)
      continue
    }
    seen.add(id)
    const o = declared.get(id)
    const item: Raw = def
      ? {
          id,
          label: def.label,
          ...(def.blockedWhileTimed ? { blockedWhileTimed: true } : {}),
          ...(def.timedReason ? { timedReason: def.timedReason } : {}),
        }
      : { id }
    if (o?.label !== undefined) item.label = o.label
    if (item.label === undefined) {
      warnings.push(`[メニュー項目 ${id}] に ラベル= がありません（この項目は省きます）`)
      continue
    }
    if (o) applyOverride(item, o, contents, warnings)
    items.push(item)
  }
  for (const o of menuItems) {
    if (!seen.has(o.id))
      warnings.push(`[メニュー項目 ${o.id}] は [メニュー] の並びにありません（使われません）`)
  }

  const raw: Raw = {}
  if (items.length > 0) raw.items = items
  else if (menu.items && menu.items.length > 0)
    warnings.push('[メニュー] に有効な項目がありません（既定の項目を使います）')
  const t = menu.transition
  if (t) {
    const transition: Raw = {}
    if (t.text_out_ms !== undefined) transition.textOutMs = t.text_out_ms
    if (t.slide_ms !== undefined) transition.slideMs = t.slide_ms
    if (t.text_in_ms !== undefined) transition.textInMs = t.text_in_ms
    if (Object.keys(transition).length > 0) raw.transition = transition
  }
  const placeNames: Record<string, string> = {}
  for (const s of scenes) {
    if (s.title !== '' && s.title !== s.id) safeAssign(placeNames, s.id, s.title)
  }
  if (Object.keys(placeNames).length > 0) raw.placeNames = placeNames
  return raw
}

function applyOverride(
  item: Raw,
  o: FieldMenuItemData,
  contents: Readonly<Record<string, unknown>> | undefined,
  warnings: string[]
): void {
  if (o.disabled === true) item.enabled = false
  if (o.reason !== undefined) item.disabledReason = o.reason
  if (o.time_limit_allowed === false) item.blockedWhileTimed = true
  else if (o.time_limit_allowed === true) {
    delete item.blockedWhileTimed
    delete item.timedReason
  }
  if (o.time_limit_reason !== undefined) item.timedReason = o.time_limit_reason
  if (o.content !== undefined) {
    if (contents && hasOwn(contents, o.content)) item.content = contents[o.content]
    else
      warnings.push(
        `[メニュー項目 ${o.id}] の 中身=${o.content} を読めていません（項目だけ残します）`
      )
  }
}
