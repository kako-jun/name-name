/**
 * フィールドの感情吹き出しの描画層 (#937)。時間・コマ・消去の計算は `fieldEmotion.ts` の純粋関数が担い、
 * ここは人物の頭上へ Sprite を置くだけ。歩行・当たり判定には触れない（位置は呼び出し側が毎フレーム渡す）。
 * 画像が読めなかった種類は `show` が false を返して出さない（フィールドは止めない）。
 */
import { Container, Rectangle, Sprite, Texture } from 'pixi.js'
import { hasOwn } from './ownProperty'
import {
  EMOTION_TARGETS,
  INITIAL_EMOTION_STATE,
  emotionAnchor,
  emotionFrameRect,
  emotionView,
  startEmotion,
  stepEmotions,
  type EmotionSheet,
  type EmotionSheets,
  type EmotionState,
  type EmotionTarget,
} from './fieldEmotion'

/** 人物の表示上端の中央（背景ピクセル）。人物が出ていないときは null */
export type EmotionHead = {
  x: number
  y: number
  /** 人物の不透明度（0..1、省略は 1）。同行者の現れる・消える途中や ghost に吹き出しも合わせる */
  alpha?: number
}
export type EmotionHeads = Partial<Record<EmotionTarget, EmotionHead | null>>

export class FieldEmotionLayer extends Container {
  private state: EmotionState = INITIAL_EMOTION_STATE
  private readonly sprites: Partial<Record<EmotionTarget, Sprite>> = {}
  private readonly frameCache = new Map<string, Texture[]>()

  /**
   * @param emotions 検証済みの宣言
   * @param textures シート画像の URL → 読み込んだテクスチャ（読めなかったものは null か未登録）
   */
  constructor(
    private readonly emotions: EmotionSheets,
    private readonly textures: ReadonlyMap<string, Texture | null>
  ) {
    super()
    this.label = 'FieldEmotionLayer'
  }

  /** 人物に吹き出しを出す（同じ人物の古い吹き出しは置き換える）。出せたら true。未宣言の種類・画像が読めない種類は false */
  show(target: EmotionTarget, kind: string): boolean {
    const sheet = hasOwn(this.emotions, kind) ? this.emotions[kind] : undefined
    if (!sheet || !this.textures.get(sheet.image)) return false
    const next = startEmotion(this.state, target, kind, this.emotions)
    if (next === this.state) return false
    this.state = next
    return true
  }

  /** 全部消す（戦闘の開始など） */
  clear(): void {
    this.state = INITIAL_EMOTION_STATE
    for (const t of EMOTION_TARGETS) this.hideSprite(t)
  }

  /** 進行中の吹き出し（検証用の読み取り） */
  active(): Partial<Record<EmotionTarget, { kind: string; elapsed: number }>> {
    const out: Partial<Record<EmotionTarget, { kind: string; elapsed: number }>> = {}
    for (const t of EMOTION_TARGETS) {
      const a = this.state[t]
      if (a) out[t] = { ...a }
    }
    return out
  }

  /** dt ms 進め、`heads` の位置に置き直す。表示時間を過ぎたものは消す */
  tick(dt: number, heads: EmotionHeads): void {
    this.state = stepEmotions(this.state, dt, this.emotions)
    for (const target of EMOTION_TARGETS) {
      const a = this.state[target]
      const head = heads[target]
      if (!a || !head) {
        this.hideSprite(target)
        continue
      }
      const sheet = this.emotions[a.kind]
      const tex = this.frameTexture(sheet, emotionView(a, sheet).frame)
      if (!tex) {
        this.hideSprite(target)
        continue
      }
      let sprite = this.sprites[target]
      if (!sprite) {
        sprite = new Sprite(tex)
        sprite.anchor.set(0.5, 1) // 下端中央が置き場所
        this.addChild(sprite)
        this.sprites[target] = sprite
      }
      const at = emotionAnchor(head, sheet)
      const s = emotionView(a, sheet).scale
      sprite.texture = tex
      sprite.scale.set(s)
      sprite.position.set(at.x, at.y)
      sprite.alpha = head.alpha ?? 1
      sprite.visible = true
    }
  }

  private hideSprite(target: EmotionTarget): void {
    const s = this.sprites[target]
    if (s) s.visible = false
  }

  private frameTexture(sheet: EmotionSheet, frame: number): Texture | null {
    const tex = this.textures.get(sheet.image)
    if (!tex) return null
    const key = `${sheet.image}#${sheet.frames}x${sheet.columns}`
    let frames = this.frameCache.get(key)
    if (!frames) {
      frames = []
      for (let i = 0; i < sheet.frames; i++) {
        const r = emotionFrameRect(sheet, tex.width, tex.height, i)
        frames.push(new Texture({ source: tex.source, frame: new Rectangle(r.x, r.y, r.w, r.h) }))
      }
      this.frameCache.set(key, frames)
    }
    return frames[frame] ?? null
  }

  override destroy(options?: Parameters<Container['destroy']>[0]): void {
    // 切り出したコマは source を共有しているので、Texture 自体だけ壊す（source は読み込み側のもの）
    for (const frames of this.frameCache.values()) for (const t of frames) t.destroy(false)
    this.frameCache.clear()
    super.destroy(options)
  }
}
