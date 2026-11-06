/**
 * 「一枚絵フィールド作品」の判定 (#1132, 親 #1096 S4b)。純関数(IO なし・決定的)。
 *
 * 規則: エントリ md を先頭から線形に(章 → 場面 → イベントの順に)見て、**最初の再生イベントが `Field`**
 * のときだけフィールド作品。それ以前に並ぶマスターデータ・地図・設定のブロックは読み飛ばす。
 * 最初の再生イベントが台詞などなら、`Field` が後ろにあってもノベルのまま(ノベルでは `Field` は no-op。往復は #1070)。
 * `RpgMap` は no-op 扱い(読み飛ばす)。RPG として扱うかは呼び出し側が `rpgProject !== null` を先に評価して決める
 * (RpgMap と Field が同居する md は RPG のまま。同居は #1070)。
 */

import type { Event, EventDocument } from '../types'
import { directionToFacing, type FieldEntry } from './fieldNotation'

export type { FieldEntry } from './fieldNotation'

/**
 * Event 共用体の各種が「ノベルの再生ストリームでどう扱われるか」。
 * - `play`: ノベル再生に載る(台詞・演出・フロー制御)。最初に出てきたらその md はフィールド作品ではない
 * - `noop`: ノベルでは何もしない(マスターデータ・地図・設定・RPG のブロック)。読み飛ばす
 * - `field`: `Field`(フィールドへ入る命令)。最初の再生イベントがこれなら作品全体がフィールド
 *
 * 根拠(実コード): `NovelRenderer.processDirective` は `dispatchDirective`(directives/ の表にある演出)と
 * `WaitDisplayComplete` / `Emotion`(警告のみで何もしない) / `Flag` / `Choice` / `Jump` / `Wait` だけを処理し、
 * それ以外のオブジェクトイベントは何もしない。そのうち「フィールド・RPG・マスターデータの記法」を `noop` にした。
 * `PageBreak` はノベルの本文の区切りなので `play`(`---` を書いた md はノベル)。
 */
export type EventRole = 'play' | 'noop' | 'field'

/** Event 共用体の種(文字列イベントはその文字列、オブジェクトイベントはキー) */
export type EventKey = Event extends infer E
  ? E extends string
    ? E
    : E extends object
      ? keyof E & string
      : never
  : never

/**
 * 種 → 役割の分類表の正本(1 か所)。`Record<EventKey, …>` なので、`Event` に種を足すと
 * ここに書き忘れた時点で tsc が落ちる。内容はテストで固定する。
 */
export const EVENT_ROLE: Readonly<Record<EventKey, EventRole>> = {
  // 本文
  Dialog: 'play',
  Narration: 'play',
  PageBreak: 'play',
  // フロー制御
  Choice: 'play',
  Condition: 'play',
  Flag: 'play',
  Jump: 'play',
  Wait: 'play',
  WaitDisplayComplete: 'play',
  // 演出(directives/ の表で処理される)
  Animate: 'play',
  Background: 'play',
  BackgroundBoard: 'play',
  BackgroundColor: 'play',
  Bgm: 'play',
  Blackout: 'play',
  CameraMode: 'play',
  Curtain: 'play',
  CurtainUp: 'play',
  DialogBorderless: 'play',
  Enter: 'play',
  EventImage: 'play',
  EventImageExit: 'play',
  Exit: 'play',
  ExpressionChange: 'play',
  Fade: 'play',
  Flash: 'play',
  Floor: 'play',
  FloorExit: 'play',
  Image: 'play',
  Label: 'play',
  PaperDollOutline: 'play',
  Prop: 'play',
  SceneTransition: 'play',
  Se: 'play',
  Shake: 'play',
  Spotlight: 'play',
  SpotlightOff: 'play',
  StageFrontExit: 'play',
  StageTurn: 'play',
  Telop: 'play',
  TextEffect: 'play',
  TitleShow: 'play',
  Underline: 'play',
  Video: 'play',
  VideoExit: 'play',
  Wall: 'play',
  WallExit: 'play',
  Weather: 'play',
  WeatherExit: 'play',
  // フィールドへ入る命令
  Field: 'field',
  // ノベルでは何もしない: フィールドの地図・設定・メニュー・人物の記法
  Emotion: 'noop', // 警告だけ(フィールドの吹き出し用)
  FieldAssist: 'noop',
  FieldEdge: 'noop',
  FieldMap: 'noop',
  FieldMenu: 'noop',
  FieldMenuItem: 'noop',
  FieldScroll: 'noop',
  FieldSettings: 'noop',
  FieldShake: 'noop',
  FieldWalkSprite: 'noop',
  FieldWarp: 'noop',
  CharacterForms: 'noop',
  UiImages: 'noop',
  Currency: 'noop',
  // ノベルでは何もしない: RPG の記法・マスターデータ
  BattleScript: 'noop',
  Item: 'noop',
  Job: 'noop',
  Magicite: 'noop',
  Monster: 'noop',
  Npc: 'noop',
  PartyMember: 'noop',
  PlayerStart: 'noop',
  RpgEvent: 'noop',
  RpgMap: 'noop',
  RpgTrigger: 'noop',
  Skill: 'noop',
  Spell: 'noop',
  Status: 'noop',
  Summon: 'noop',
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** イベント 1 つの役割。未知の種(parser が新しく足した等)は安全側で `play`(= フィールド作品にしない) */
export function roleOfEvent(event: Event): EventRole {
  if (typeof event === 'string')
    return hasOwn(EVENT_ROLE, event) ? EVENT_ROLE[event as EventKey] : 'play'
  if (event === null || typeof event !== 'object') return 'play'
  const keys = Object.keys(event)
  // 値が 1 キーのオブジェクトが正規形。複数キーなら 1 つでも noop 以外があれば play 側に倒す
  let role: EventRole = 'noop'
  if (keys.length === 0) return 'play'
  for (const k of keys) {
    const r: EventRole = hasOwn(EVENT_ROLE, k) ? EVENT_ROLE[k as EventKey] : 'play'
    if (r === 'play') return 'play'
    if (r === 'field') role = 'field'
  }
  return role
}

/** エントリ doc を先頭から線形に見て、最初の再生イベントが `Field` なら入口の位置を返す。そうでなければ null */
export function fieldEntryOfDoc(doc: EventDocument): FieldEntry | null {
  for (const chapter of doc?.chapters ?? []) {
    for (const scene of chapter?.scenes ?? []) {
      for (const ev of scene?.events ?? []) {
        const role = roleOfEvent(ev)
        if (role === 'noop') continue
        if (role === 'play') return null
        // role === 'field'
        if (typeof ev === 'string' || !('Field' in ev)) return null
        const f = ev.Field
        const out: FieldEntry = { sceneId: f.scene }
        if (f.x !== undefined && f.x !== null) out.x = f.x
        if (f.y !== undefined && f.y !== null) out.y = f.y
        const facing = directionToFacing(f.direction ?? undefined)
        if (facing !== undefined) out.facing = facing
        return out
      }
    }
  }
  return null
}
