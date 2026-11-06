/**
 * 一枚絵フィールド (#807) の開発ページ (field.html) の起動。本編からはリンクしない。
 * `?config=<URL>` の設定 JSON を読み、field.html の DOM を `startFieldGame` (./startFieldGame.ts) へ渡すだけの薄い層。
 */
import { resolveUrl } from '../battle/config'
import { configNotice, parseConfigText, pickConfigSource, type FieldConfig } from './config'
import { parseCharacterFormsManifest, expandCharacterForms } from './characterForms'
import { FIELD_DOC_KEY, savedFormsFromResume, withResumeSlot } from './fieldResume'
import { startFieldGame } from './startFieldGame'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** 設定の読み込み中に出した通知（置換方式）。起動後は startFieldGame が引き継ぐ */
let loadNotice: string | null = null
function showError(msg: string | null): void {
  loadNotice = msg
  const el = $('error')
  el.textContent = msg
  el.hidden = !msg
}

/**
 * 人物の形態から絵を導く (#1020)。設定 JSON に `characterForms` があるときだけ、目録（`manifestUrl`）を fetch して
 * `party[].poses` / `player.sprites` を埋めた JSON 文字列を返す。形態はセーブ（`?resume=`）の指定が設定の既定に優先する。
 * 目録の取得・検証に失敗したら理由を画面に出し、手を入れない（絵が足りなければ後段の設定検証が落ちる）
 */
async function expandFormsInText(text: string, textBase: string): Promise<string> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return text // 後段の parseConfigText が理由つきで失敗にする
  }
  const cf = (raw as { characterForms?: { manifestUrl?: unknown } } | null)?.characterForms
  if (!cf) return text
  try {
    const mu = typeof cf.manifestUrl === 'string' ? resolveUrl(cf.manifestUrl, textBase) : null
    if (!mu) throw new Error('characterForms.manifestUrl の URL を解決できません')
    const res = await fetch(mu)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${mu}`)
    const manifest = parseCharacterFormsManifest(await res.json())
    if (!manifest.ok) throw new Error(`${mu}: ${manifest.error}`)
    const out = expandCharacterForms(raw, manifest.value, savedFormsFromResume(location.search))
    for (const w of out.warnings) console.warn(`[field] characterForms: ${w}`)
    return JSON.stringify(out.raw)
  } catch (e) {
    showError(
      `人物の形態の目録を読み込めません（絵の導出をしません）\n${e instanceof Error ? e.message : String(e)}`
    )
    return text
  }
}

/** 設定 JSON を読む。`?config=<URL>` が無い・読めない・不正のときはエラーを出して null（起動しない） */
async function loadConfig(): Promise<FieldConfig | null> {
  const base = location.href
  const raw = pickConfigSource(location.search)
  const url = raw ? resolveUrl(raw, base) : null
  if (!url) {
    showError('`?config=<URL>` で設定 JSON を指定してください')
    return null
  }
  let text: string
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    text = await res.text()
  } catch (e) {
    showError(`設定 JSON を読み込めません\n${url}\n${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  text = await expandFormsInText(text, url)
  const parsed = parseConfigText(text, url)
  if (parsed.ok) {
    // 群エラー (#839 段5。console.error は parseConfig が出している) と警告 (#883) は 1 回でまとめて出す
    // （showError は置換なので別々に呼ぶと後が前を消す）
    for (const w of parsed.value.warnings ?? []) console.warn(w)
    const notice = configNotice(parsed.value)
    if (notice) showError(notice)
    return parsed.value
  }
  showError(`設定 JSON が不正です\n${parsed.error}`)
  return null
}

async function main(): Promise<void> {
  const config = await loadConfig()
  if (!config) return
  await startFieldGame({
    config,
    mount: $('stage'),
    hud: { error: $('error'), info: $('info'), initialNotice: loadNotice },
    devToolbar: {
      debug: $<HTMLInputElement>('tb-debug'),
      forceBattle: $('tb-force-battle'),
      flags: $('tb-flags'),
      emotions: $('tb-emotions'),
      warps: $('tb-warps'),
    },
    docKey: FIELD_DOC_KEY,
    search: location.search,
    containHost: document.body,
    onLoadRequest: (slot) => {
      location.search = withResumeSlot(location.search, slot)
    },
  })
}

main().catch((e) => {
  showError(`起動に失敗しました\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
})
