/**
 * 警告の言い換え (#1129 / 親 #1096 S3e)。
 *
 * md から組んだ raw を `parseConfig` / `expandCharacterForms` に通すと、警告が JSON のパス表記
 * (`player.cycle` `gearShop.entries[0].abilities` `scenes.x.npcs[1]` など)で出る。md を書く人には読めないので、
 * 記法の言い方(`[歩行絵 主人公] の 周期=` `[アイテム blade1] の わざ:` など)に直す。純関数。
 *
 * 表に無い文言・パスは触らない(JSON パスのまま出す。既存の言い方を壊さない)。
 * 位置を名前で言い直すため、警告を出した raw(配列の添字 → id/name の引き当て)を受け取る。
 */

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const WALK_KEYS: Record<string, string> = {
  character: '人物=',
  form: '形態=',
  height: '高さ=',
  frameMs: 'コマ長=',
  cycle: '周期=',
  idleFrame: '停止=',
  name: '名前=',
  sprites: '歩行絵',
}
const ASSIST_KEYS: Record<string, string> = {
  requires: '条件=',
  unless: '除く=',
  ghostWhen: '幽霊=',
  speedFactor: '速度倍率=',
  ghostAlpha: '濃さ=',
  offset: '後ろ=',
  fadeMs: 'フェード=',
}
const GEAR_KEYS: Record<string, string> = {
  kind: '売り物:',
  name: '名前:',
  owner: '持ち主:',
  basePrice: '基準額:',
  price: '価格:',
  unlockFlag: '解禁:',
  image: '画像:',
  lockedMessage: '解禁前の文:',
  equipBonus: '装備時:',
  abilities: 'わざ:',
}
const MENU_ITEM_KEYS: Record<string, string> = {
  label: 'ラベル=',
  enabled: '無効=',
  disabledReason: '理由=',
  blockedWhileTimed: '時間制限=',
  timedReason: '時間制限の理由=',
  content: '中身=',
}
const NPC_KEYS: Record<string, string> = {
  name: '名前',
  x: '@x,y',
  y: '@x,y',
  line: '台詞',
  sprite: 'sprite=',
  sprites: '絵=',
  height: '高さ=',
  facing: '向き=',
  scene: 'scene=',
}
const SCENE_KEYS: Record<string, string> = {
  encounter: '[エンカウント率:] / [エンカウント群:]',
  links: '[端]',
  shake: '[揺れ:]',
  scroll: '[窓の景色:]',
}
const MASTER_ARRAYS: Record<string, string> = {
  items: 'アイテム',
  spells: '呪文',
  skills: '特技',
  party: 'パーティ',
}

function at(arr: unknown, n: number, key: string): string | undefined {
  if (!Array.isArray(arr)) return undefined
  const v: unknown = arr[n]
  return isObj(v) && typeof v[key] === 'string' ? (v[key] as string) : undefined
}

/** `.key` の付いた位置を「<対象> の <記法の言い方>」にする。キーが表に無ければ英語のキー名のまま続ける */
function withKey(
  target: string,
  key: string | undefined,
  table: Record<string, string>,
  bare: string
): string {
  if (key === undefined) return `${target} の ${bare}`
  return Object.prototype.hasOwnProperty.call(table, key)
    ? `${target} の ${table[key]}`
    : `${target} の ${key}`
}

/** 警告 1 件を、md の書き方で読める言い方に直す。`raw` は警告を出した設定(parseConfig に通した JSON 形) */
export function describeWarning(message: string, raw: unknown): string {
  const r = isObj(raw) ? raw : {}
  let s = message

  // 文ごと置き換える(JSON のキー名が文中に混じるもの)
  s = s.replace(
    /gearShop の刀 "(.+?)" の abilities "(.+?)" は skills に無い特技です/g,
    "[アイテム $1] の わざ: に挙げた '$2' が [特技] にありません"
  )
  s = s.replace(
    /skills の "(.+?)" は gearShop のどの刀の abilities にも挙がっていません/g,
    '[特技 $1] はどの刀の わざ: にも挙がっていません'
  )
  s = s.replace(/cycle と idleFrame を組で書いてください/g, '周期= と 停止= を組で書いてください')
  s = s.replace(
    /(player|companion)\.cycle だけで \1\.idleFrame がありません/g,
    (_m, who) =>
      `${who === 'player' ? '[歩行絵 主人公]' : '[歩行絵 同行者]'} に 周期= だけで 停止= がありません`
  )
  s = s.replace(
    /に form（または同じ人物の味方の form）がありません/g,
    'に 形態=（または同じ人物の味方の 形態:）がありません'
  )
  s = s.replace(/に form がありません/g, 'に 形態: がありません')
  s = s.replace(
    /characterForms\.root は URL 文字列が必要です/g,
    '[人物の形態] の 素材= は URL 文字列が必要です'
  )

  // 場面の NPC / 場面(場面 ID は `.` を含みうる(見出しの id をそのまま通す)ので、既知のキー名の手前までを ID とする)
  s = s.replace(/scenes\.(.+?)\.npcs\[(\d+)\](?:\.(\w+))?/g, (_m, sid, n, key) => {
    const scenes = isObj(r.scenes) ? r.scenes : {}
    const sc = isObj(scenes[sid]) ? (scenes[sid] as Obj) : {}
    const name = at(sc.npcs, Number(n), 'name')
    const target = `場面 ${sid} の NPC${name !== undefined ? ` '${name}'` : ` ${Number(n) + 1} 人目`}`
    return key === undefined ? target : withKey(target, key, NPC_KEYS, '')
  })
  s = s.replace(/scenes\.(.+?)\.npcs の (\S+)/g, "場面 $1 の NPC '$2'")
  s = s.replace(
    /scenes\.(.+?)\.(npcs|encounter|links|shake|scroll|background|mask|foreground|playerHeight)(?:\.(\w+))?/g,
    (_m, sid, key, sub) => {
      if (!Object.prototype.hasOwnProperty.call(SCENE_KEYS, key)) return `場面 ${sid} の ${key}`
      return `場面 ${sid} の ${SCENE_KEYS[key]}${sub !== undefined ? `（${sub}）` : ''}`
    }
  )

  // メニュー
  s = s.replace(/menu\.items\[(\d+)\](?:\.(\w+))?/g, (_m, n, key) => {
    const menu = isObj(r.menu) ? r.menu : {}
    const id = at(menu.items, Number(n), 'id')
    const target =
      id !== undefined ? `[メニュー項目 ${id}]` : `[メニュー] の ${Number(n) + 1} 番目の項目`
    return key === undefined ? target : withKey(target, key, MENU_ITEM_KEYS, '')
  })
  s = s.replace(/menu\.placeNames\.(\S+)/g, '場面 $1 の見出し（[メニュー] の場所名）')
  s = s.replace(/menu\.placeNames/g, '[メニュー] の場所名')
  s = s.replace(/menu\.items に有効な項目がありません/g, '[メニュー] に有効な項目がありません')
  s = s.replace(/menu\.items は配列にしてください/g, '[メニュー] の項目は配列にしてください')
  s = s.replace(/menu\.(\w+)/g, (_m, key) => `[メニュー] の ${key}`)

  // 売り物
  s = s.replace(/gearShop\.entries\[(\d+)\](?:\.(\w+))?/g, (_m, n, key) => {
    const gear = isObj(r.gearShop) ? r.gearShop : {}
    const id = at(gear.entries, Number(n), 'id')
    const target = id !== undefined ? `[アイテム ${id}]` : `売り物 ${Number(n) + 1} 件目`
    return withKey(target, key, GEAR_KEYS, '売り物')
  })

  // 主人公・同行者・補助通行・味方・マスター配列
  const walk = (word: 'player' | 'companion', label: string) => {
    s = s.replace(new RegExp(`(^|[^\\w.])${word}\\.(\\w+)`, 'g'), (_m, pre, key) => {
      const t = withKey(label, key, WALK_KEYS, '')
      return `${pre}${t}`
    })
    s = s.replace(new RegExp(`(^|[^\\w.\\[])${word}(?= の| に)`, 'g'), `$1${label}`)
  }
  walk('player', '[歩行絵 主人公]')
  walk('companion', '[歩行絵 同行者]')
  s = s.replace(/assist\.(\w+)/g, (_m, key) => withKey('[補助通行]', key, ASSIST_KEYS, ''))
  s = s.replace(/battle\.currencyName/g, '[通貨名:]')
  s = s.replace(/monsters\.([^.\s]+)(?:\.(\w+))?/g, (_m, id, key) =>
    key === undefined ? `[モンスター ${id}]` : `[モンスター ${id}] の ${key}`
  )
  s = s.replace(/\b(items|spells|skills|party)\[(\d+)\](?:\.(\w+))?/g, (_m, arr, n, key) => {
    const id = at(r[arr], Number(n), 'id')
    const label = MASTER_ARRAYS[arr]
    const target = id !== undefined ? `[${label} ${id}]` : `[${label}] の ${Number(n) + 1} 件目`
    return key === undefined ? target : `${target} の ${key}`
  })
  // expandCharacterForms の `party[0] (p1)` は上で `[パーティ p1] (p1)` になるので括弧の重複を畳む
  s = s.replace(/(\[パーティ ([^\]]+)\]) \(\2\)/g, '$1')
  return s
}

/** 警告の配列をまとめて言い換える */
export function describeWarnings(messages: readonly string[], raw: unknown): string[] {
  return messages.map((m) => describeWarning(m, raw))
}
