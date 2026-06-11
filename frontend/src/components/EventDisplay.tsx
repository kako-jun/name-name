import type { Event } from '../types'

interface EventDisplayProps {
  event: Event
  isDark: boolean
}

/**
 * Event の variant ごとに読み取り専用の表示を返す。
 * EventCard 内の編集 UI と同じカードに差し替える形で使われる。
 *
 * Issue #234: 旧版は新 variant (Animate / Monster / Item / Spell / PartyMember /
 * RpgEvent / RpgTrigger / Npc / RpgMap / PlayerStart / TitleShow /
 * DialogBorderless / Shake / Flash / Fade) を return null で握り潰していた。
 * data.md 等のマスター .md を読んだときにエディタ上で全部空に見える問題を解消する。
 */
function EventDisplay({ event, isDark }: EventDisplayProps) {
  const meta = isDark ? 'text-gray-500' : 'text-gray-500'
  const accent = isDark ? 'text-gray-400' : 'text-gray-600'
  const head = isDark ? 'text-gray-300' : 'text-gray-700'

  if (typeof event === 'string') {
    return <div className={`text-sm italic ml-2 ${accent}`}>[場面転換]</div>
  }

  if ('Dialog' in event) {
    const d = event.Dialog
    const badges: string[] = []
    if (d.voice_path) badges.push(`🔊 ${d.voice_path}`)
    if (d.font_family) badges.push(`𝐀 ${d.font_family}`)
    return (
      <div className="space-y-1">
        <div className={`text-sm font-semibold ml-2 ${head}`}>
          {d.character || '（キャラクター名）'}
          {d.position && <span className={`ml-2 text-xs font-normal ${meta}`}>@ {d.position}</span>}
        </div>
        <div className={`text-sm ml-2 font-mono whitespace-pre-wrap ${accent}`}>
          {d.text.join('\n') || '（テキスト）'}
        </div>
        {d.expression && <div className={`text-xs italic ml-2 ${meta}`}>表情: {d.expression}</div>}
        {badges.length > 0 && <div className={`text-xs ml-2 ${meta}`}>{badges.join(' / ')}</div>}
      </div>
    )
  }

  if ('Narration' in event) {
    const n = event.Narration
    const badges: string[] = []
    if (n.voice_path) badges.push(`🔊 ${n.voice_path}`)
    if (n.font_family) badges.push(`𝐀 ${n.font_family}`)
    return (
      <div className="space-y-1">
        <div className={`text-sm ml-2 font-mono whitespace-pre-wrap ${accent}`}>
          {n.text.join('\n') || '（ナレーション）'}
        </div>
        {badges.length > 0 && <div className={`text-xs ml-2 ${meta}`}>{badges.join(' / ')}</div>}
      </div>
    )
  }

  if ('Background' in event) {
    return <div className={`text-xs italic ml-2 ${meta}`}>背景: {event.Background.path}</div>
  }

  if ('Bgm' in event) {
    const fade = event.Bgm.fade_ms != null ? ` (フェード ${event.Bgm.fade_ms}ms)` : ''
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        BGM {event.Bgm.action === 'Play' ? '再生' : '停止'}: {event.Bgm.path ?? '(なし)'}
        {fade}
      </div>
    )
  }

  if ('Se' in event) {
    const fade = event.Se.fade_ms != null ? ` (フェード ${event.Se.fade_ms}ms)` : ''
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        SE: {event.Se.path}
        {fade}
      </div>
    )
  }

  if ('Blackout' in event) {
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        暗転{event.Blackout.action === 'On' ? '' : '解除'}
      </div>
    )
  }

  if ('Exit' in event) {
    return <div className={`text-xs italic ml-2 ${meta}`}>退場: {event.Exit.character}</div>
  }

  if ('Wait' in event) {
    return <div className={`text-xs italic ml-2 ${meta}`}>待機: {event.Wait.ms}ms</div>
  }

  if ('ExpressionChange' in event) {
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        表情変更: {event.ExpressionChange.character} → {event.ExpressionChange.expression}
      </div>
    )
  }

  if ('Choice' in event) {
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        選択肢: {event.Choice.options.map((o) => `${o.text} → ${o.jump}`).join(' / ')}
      </div>
    )
  }

  if ('Flag' in event) {
    const v = event.Flag.value
    let valueStr = ''
    if ('Bool' in v) valueStr = String(v.Bool)
    else if ('String' in v) valueStr = v.String
    else if ('Number' in v) valueStr = String(v.Number)
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        フラグ: {event.Flag.name} = {valueStr}
      </div>
    )
  }

  if ('Condition' in event) {
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        条件分岐: {event.Condition.flag}（{event.Condition.events.length} イベント）
      </div>
    )
  }

  // ----- RPG マスターデータ (#174 / #175) -----
  if ('Monster' in event) {
    const m = event.Monster
    const tag = m.builtin ? ` builtin=${m.builtin}` : ''
    return (
      <div className="space-y-0.5">
        <div className={`text-sm font-semibold ml-2 ${head}`}>
          👾 モンスター: {m.name}{' '}
          <span className={`text-xs font-normal ${meta}`}>
            (id={m.id}
            {tag})
          </span>
        </div>
        <div className={`text-xs ml-4 font-mono ${accent}`}>
          HP={m.hp} ATK={m.atk} DEF={m.def} AGI={m.agi} EXP={m.exp} GOLD={m.gold}
          {m.mp ? ` MP=${m.mp}` : ''}
          {m.sprite ? ` sprite=${m.sprite}` : ''}
        </div>
      </div>
    )
  }

  if ('Item' in event) {
    const i = event.Item
    return (
      <div className="space-y-0.5">
        <div className={`text-sm font-semibold ml-2 ${head}`}>
          🧪 アイテム: {i.name} <span className={`text-xs font-normal ${meta}`}>(id={i.id})</span>
        </div>
        <div className={`text-xs ml-4 font-mono ${accent}`}>
          種別={i.kind}
          {i.price != null ? ` 価格=${i.price}` : ''}
          {i.effect ? ` 効果=${i.effect}` : ''}
          {i.builtin ? ` builtin=${i.builtin}` : ''}
        </div>
      </div>
    )
  }

  if ('Spell' in event) {
    const s = event.Spell
    return (
      <div className="space-y-0.5">
        <div className={`text-sm font-semibold ml-2 ${head}`}>
          ✨ 呪文: {s.name} <span className={`text-xs font-normal ${meta}`}>(id={s.id})</span>
        </div>
        <div className={`text-xs ml-4 font-mono ${accent}`}>
          MP={s.mp} 対象={s.target}
          {s.school ? ` 系統=${s.school}` : ''}
          {s.effect ? ` 効果=${s.effect}` : ''}
          {s.builtin ? ` builtin=${s.builtin}` : ''}
        </div>
      </div>
    )
  }

  if ('PartyMember' in event) {
    const p = event.PartyMember
    const learns = p.learns?.map((l) => `Lv${l.level} ${l.spell}`).join(', ')
    return (
      <div className="space-y-0.5">
        <div className={`text-sm font-semibold ml-2 ${head}`}>
          🛡 パーティ: {p.name}{' '}
          <span className={`text-xs font-normal ${meta}`}>
            (id={p.id}
            {p.level != null ? ` Lv${p.level}` : ''})
          </span>
        </div>
        <div className={`text-xs ml-4 font-mono ${accent}`}>
          HP={p.hp} ATK={p.atk} DEF={p.def} AGI={p.agi}
          {p.mp ? ` MP=${p.mp}` : ''}
          {p.sprite ? ` sprite=${p.sprite}` : ''}
        </div>
        {learns && <div className={`text-xs ml-4 ${meta}`}>習得: {learns}</div>}
      </div>
    )
  }

  // ----- RPG マップ / NPC / プレイヤー -----
  if ('RpgMap' in event) {
    const m = event.RpgMap
    const enc =
      m.encounter_rate != null ? `エンカウント率=1/${m.encounter_rate}` : 'エンカウントなし'
    const groups = m.encounter_groups?.join(', ')
    return (
      <div className="space-y-0.5">
        <div className={`text-sm font-semibold ml-2 ${head}`}>
          🗺 マップ {m.width}×{m.height}{' '}
          <span className={`text-xs font-normal ${meta}`}>(タイル {m.tile_size}px)</span>
        </div>
        <div className={`text-xs ml-4 ${meta}`}>
          {enc}
          {groups ? ` / 群: ${groups}` : ''}
        </div>
      </div>
    )
  }

  if ('PlayerStart' in event) {
    const p = event.PlayerStart
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        プレイヤー初期位置: @{p.x},{p.y} 向き={p.direction}
      </div>
    )
  }

  if ('Npc' in event) {
    const n = event.Npc
    return (
      <div className="space-y-0.5">
        <div className={`text-sm font-semibold ml-2 ${head}`}>
          🧍 NPC: {n.name}{' '}
          <span className={`text-xs font-normal ${meta}`}>
            (id={n.id} @{n.x},{n.y})
          </span>
        </div>
        {n.message.length > 0 && (
          <div className={`text-xs ml-4 font-mono whitespace-pre-wrap ${accent}`}>
            {n.message.join('\n')}
          </div>
        )}
        {(n.sprite || n.portrait || n.direction) && (
          <div className={`text-xs ml-4 ${meta}`}>
            {n.sprite ? `sprite=${n.sprite} ` : ''}
            {n.portrait ? `portrait=${n.portrait} ` : ''}
            {n.direction ? `向き=${n.direction}` : ''}
          </div>
        )}
      </div>
    )
  }

  if ('RpgEvent' in event) {
    const e = event.RpgEvent
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        イベント: {e.name}（{e.commands.length} コマンド）
      </div>
    )
  }

  if ('RpgTrigger' in event) {
    const t = event.RpgTrigger
    const loc = t.auto ? 'auto' : `@${t.x},${t.y}`
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        トリガー {loc} → scene={t.scene}
        {t.once ? ' once' : ''}
      </div>
    )
  }

  // ----- アニメ / 演出 -----
  if ('Animate' in event) {
    const a = event.Animate
    const parts: string[] = []
    if (a.dx != null) parts.push(`dx=${a.dx}`)
    if (a.dy != null) parts.push(`dy=${a.dy}`)
    if (a.rotation != null) parts.push(`rot=${a.rotation}`)
    if (a.scale != null) parts.push(`scale=${a.scale}`)
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        アニメ: {a.target} {parts.join(' ')} ({a.duration_ms}ms
        {a.easing && a.easing !== 'Linear' ? ` ${a.easing}` : ''})
      </div>
    )
  }

  if ('TextEffect' in event) {
    const te = event.TextEffect
    const parts: string[] = []
    if (te.effect != null) parts.push(te.effect === 'Explode' ? '爆発' : 'タイプ')
    if (te.stagger_ms != null) parts.push(`間隔=${te.stagger_ms}`)
    if (te.ms_per_char != null) parts.push(`速度=${te.ms_per_char}`)
    if (te.dx != null) parts.push(`dx=${te.dx}`)
    if (te.dy != null) parts.push(`dy=${te.dy}`)
    if (te.rotation != null) parts.push(`rot=${te.rotation}`)
    if (te.scale != null) parts.push(`scale=${te.scale}`)
    if (te.alpha != null) parts.push(`alpha=${te.alpha}`)
    if (te.duration_ms != null) parts.push(`${te.duration_ms}ms`)
    if (te.easing && te.easing !== 'Linear') parts.push(te.easing)
    // #271 点滅カーソル
    if (te.cursor === true) parts.push('カーソル')
    if (te.blink_ms != null) parts.push(`点滅=${te.blink_ms}`)
    if (te.cursor_color != null) parts.push(`カーソル色=${te.cursor_color}`)
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        文字演出: {te.target}
        {parts.length > 0 ? ` ${parts.join(' ')}` : ''}
      </div>
    )
  }

  if ('Underline' in event) {
    const u = event.Underline
    const parts: string[] = []
    if (u.color != null) parts.push(`色=${u.color}`)
    if (u.thickness != null) parts.push(`太さ=${u.thickness}`)
    if (u.duration_ms != null) parts.push(`${u.duration_ms}ms`)
    if (u.offset != null) parts.push(`余白=${u.offset}`)
    if (u.easing && u.easing !== 'Linear') parts.push(u.easing)
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        下線: {u.target}
        {parts.length > 0 ? ` ${parts.join(' ')}` : ''}
      </div>
    )
  }

  if ('DialogBorderless' in event) {
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        {event.DialogBorderless.borderless ? '枠なし' : '枠あり'}
      </div>
    )
  }

  if ('Shake' in event) {
    const s = event.Shake
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        シェイク: {s.intensity_px}px / {s.duration_ms}ms
      </div>
    )
  }

  if ('Flash' in event) {
    const f = event.Flash
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        フラッシュ: {f.color} α={f.alpha} / {f.duration_ms}ms
      </div>
    )
  }

  if ('Fade' in event) {
    const f = event.Fade
    return (
      <div className={`text-xs italic ml-2 ${meta}`}>
        フェード: {f.target} {f.color} {f.from_alpha}→{f.to_alpha} / {f.duration_ms}ms
      </div>
    )
  }

  // 未知の variant: 旧 return null で握り潰していた問題の防衛策。
  // 表示することで「エディタが対応していない新 variant がある」ことが目視できる。
  const key = Object.keys(event)[0] ?? '?'
  return (
    <div className={`text-xs italic ml-2 ${meta}`} data-testid="event-unknown">
      ⚠ 未対応イベント: {key}
    </div>
  )
}

export default EventDisplay
