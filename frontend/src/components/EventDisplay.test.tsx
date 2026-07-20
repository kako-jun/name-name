// Issue #234: EventDisplay が parser の全 variant をエディタ上で可視化することを保証する。
// 旧版は新 variant (Animate / Monster / Item / Spell / PartyMember / Npc / RpgMap /
// PlayerStart / RpgEvent / RpgTrigger / DialogBorderless / Shake / Flash / Fade) を
// return null で握り潰しており、data.md 等のマスター .md がエディタ上で空に見える
// 問題を生んでいた。各 variant が「何かしらテキストを描画する」ことを担保する。
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import EventDisplay from './EventDisplay'
import type { Event } from '../types'

function renderEvent(event: Event) {
  return render(<EventDisplay event={event} isDark={false} />)
}

describe('EventDisplay', () => {
  it('renders SceneTransition', () => {
    const { container } = renderEvent('SceneTransition')
    expect(container.textContent).toContain('場面転換')
  })

  it('renders WaitDisplayComplete as display wait, not SceneTransition', () => {
    const { container } = renderEvent('WaitDisplayComplete')
    expect(container.textContent).toContain('待機: 表示完了')
    expect(container.textContent).not.toContain('場面転換')
  })

  it('renders Dialog with voice and font badges (#144 / #147)', () => {
    const { container } = renderEvent({
      Dialog: {
        character: 'ナレーター',
        expression: 'smile',
        position: '中央',
        text: ['こんにちは'],
        voice_path: 'voice/hello.mp3',
        font_family: 'Klee One, cursive',
      },
    })
    expect(container.textContent).toContain('ナレーター')
    expect(container.textContent).toContain('@ 中央')
    expect(container.textContent).toContain('こんにちは')
    expect(container.textContent).toContain('表情: smile')
    expect(container.textContent).toContain('voice/hello.mp3')
    expect(container.textContent).toContain('Klee One, cursive')
  })

  it('renders Narration with voice/font badges', () => {
    const { container } = renderEvent({
      Narration: { text: ['静かな夜だった'], voice_path: 'v.mp3', font_family: null },
    })
    expect(container.textContent).toContain('静かな夜だった')
    expect(container.textContent).toContain('v.mp3')
  })

  it('renders Background / Bgm fade / Se fade', () => {
    expect(renderEvent({ Background: { path: 'title.png' } }).container.textContent).toContain(
      'title.png'
    )
    expect(
      renderEvent({ Bgm: { path: 'bgm.ogg', action: 'Play', fade_ms: 800 } }).container.textContent
    ).toContain('フェード 800ms')
    expect(
      renderEvent({ Se: { path: 'chime.wav', fade_ms: 200 } }).container.textContent
    ).toContain('フェード 200ms')
  })

  it('renders Blackout / Exit / Wait / ExpressionChange', () => {
    expect(renderEvent({ Blackout: { action: 'On' } }).container.textContent).toContain('暗転')
    expect(renderEvent({ Exit: { character: '長老' } }).container.textContent).toContain('長老')
    expect(
      renderEvent({ Exit: { character: '長老', fade_ms: 2100 } }).container.textContent
    ).toContain('フェード 2100ms')
    expect(renderEvent({ Wait: { ms: 400 } }).container.textContent).toContain('400ms')
    expect(
      renderEvent({ ExpressionChange: { character: 'A', expression: 'sad' } }).container.textContent
    ).toContain('sad')
  })

  it('renders Choice with jump targets', () => {
    const { container } = renderEvent({
      Choice: {
        options: [
          { text: 'はい', jump: '1-2' },
          { text: 'いいえ', jump: '1-3' },
        ],
      },
    })
    expect(container.textContent).toContain('はい → 1-2')
    expect(container.textContent).toContain('いいえ → 1-3')
  })

  it('renders Flag / Condition', () => {
    expect(
      renderEvent({ Flag: { name: 'saw_characters', value: { Bool: true } } }).container.textContent
    ).toContain('saw_characters = true')
    expect(
      renderEvent({ Condition: { flag: 'has_key', events: [] } }).container.textContent
    ).toContain('has_key')
  })

  // ----- RPG マスターデータ (#234 の本丸) -----
  it('renders Monster master data', () => {
    const { container } = renderEvent({
      Monster: {
        id: 'slime',
        name: 'スライム',
        hp: 10,
        mp: 0,
        atk: 3,
        def: 1,
        agi: 2,
        exp: 2,
        gold: 1,
      },
    })
    expect(container.textContent).toContain('スライム')
    expect(container.textContent).toContain('id=slime')
    expect(container.textContent).toContain('HP=10')
    expect(container.textContent).toContain('ATK=3')
  })

  it('renders Item master data', () => {
    const { container } = renderEvent({
      Item: { id: 'やくそう', name: 'やくそう', kind: '回復', price: 8, effect: 'heal 30' },
    })
    expect(container.textContent).toContain('やくそう')
    expect(container.textContent).toContain('種別=回復')
    expect(container.textContent).toContain('効果=heal 30')
  })

  it('renders Spell master data', () => {
    const { container } = renderEvent({
      Spell: { id: 'ホイミ', name: 'ホイミ', mp: 4, target: '味方単体', effect: 'heal 15..25' },
    })
    expect(container.textContent).toContain('ホイミ')
    expect(container.textContent).toContain('対象=味方単体')
  })

  it('renders PartyMember with learns', () => {
    const { container } = renderEvent({
      PartyMember: {
        id: 'hero',
        name: 'ゆうしゃ',
        level: 1,
        hp: 20,
        mp: 4,
        atk: 5,
        def: 3,
        agi: 4,
        learns: [
          { level: 4, spell: 'ホイミ' },
          { level: 7, spell: 'メラ' },
        ],
      },
    })
    expect(container.textContent).toContain('ゆうしゃ')
    expect(container.textContent).toContain('Lv4 ホイミ')
    expect(container.textContent).toContain('Lv7 メラ')
  })

  it('renders RpgMap / PlayerStart / Npc', () => {
    expect(
      renderEvent({
        RpgMap: {
          width: 12,
          height: 10,
          tile_size: 32,
          tiles: [],
          encounter_rate: 8,
          encounter_groups: ['slime', 'ghost'],
        },
      }).container.textContent
    ).toContain('1/8')
    expect(
      renderEvent({ PlayerStart: { x: 5, y: 7, direction: 'Up' } }).container.textContent
    ).toContain('@5,7')
    expect(
      renderEvent({
        Npc: {
          id: 'ガイド',
          name: 'ガイド',
          x: 5,
          y: 4,
          color: 0x88ccff,
          message: ['ようこそ'],
        },
      }).container.textContent
    ).toContain('ようこそ')
  })

  it('renders RpgEvent / RpgTrigger', () => {
    expect(
      renderEvent({ RpgEvent: { name: 'opening', commands: [] } }).container.textContent
    ).toContain('opening')
    expect(
      renderEvent({ RpgTrigger: { x: 3, y: 4, scene: 'opening', once: true, auto: false } })
        .container.textContent
    ).toContain('@3,4')
    expect(
      renderEvent({ RpgTrigger: { auto: true, scene: 'autoplay' } }).container.textContent
    ).toContain('auto')
  })

  it('renders Animate / DialogBorderless / Shake / Flash / Fade', () => {
    expect(
      renderEvent({
        Animate: { target: '車', dx: '+500', duration_ms: 1000, easing: 'EaseInOut' },
      }).container.textContent
    ).toMatch(/車.*dx=\+500.*1000ms.*EaseInOut/)
    expect(renderEvent({ DialogBorderless: { borderless: true } }).container.textContent).toContain(
      '枠なし'
    )
    expect(
      renderEvent({ Shake: { intensity_px: 10, duration_ms: 500 } }).container.textContent
    ).toContain('10px')
    expect(
      renderEvent({ Flash: { color: '#fff', alpha: 0.8, duration_ms: 300 } }).container.textContent
    ).toContain('α=0.8')
    expect(
      renderEvent({
        Fade: {
          target: 'all',
          color: '#000',
          from_alpha: 0,
          to_alpha: 1,
          duration_ms: 500,
        },
      }).container.textContent
    ).toContain('all')
  })

  it('renders an unknown event variant with a warning instead of returning null', () => {
    // parser が将来 variant を増やしたときに「空表示でユーザーが気付かない」事故を防ぐ。
    // TS の Event 型に未定義の variant も実 JSON では来うる（WASM 出力 vs TS 型のズレ等）ので、
    // 型を一旦 any で剥がして「未知の variant」を投入する。
    const unknown = { SomeFutureVariant: { foo: 'bar' } } as unknown as Event
    const { getByTestId } = renderEvent(unknown)
    expect(getByTestId('event-unknown').textContent).toContain('SomeFutureVariant')
  })
})
