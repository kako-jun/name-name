/**
 * 立ち絵表示レイヤー
 *
 * PixiJS Container 上でキャラクター立ち絵の表示・表情変更・退場を管理する。
 */

import { Assets, Container, Sprite } from 'pixi.js'

/** キャラクターの画面上の配置位置 */
const POSITION_X: Record<string, number> = {
  left: 150,
  center: 400,
  right: 650,
}

/**
 * 日本語表記の position を英語 key に正規化する。
 * パーサーは "中央" 等の日本語表記をそのまま position 文字列に流すため、
 * CharacterLayer 側で受ける必要がある (#133)。
 *
 * サポートする表記:
 *   - 英語: left / center / right
 *   - 英語ゆれ (case / 綴り): Left / Center / Centre / Right
 *   - 日本語 (左): 左 / 左寄り / 左端
 *   - 日本語 (中央): 中央 / 真ん中 / まんなか / 真中 / 中
 *   - 日本語 (右): 右 / 右寄り / 右端
 *
 * 未知の値が来たら CharacterLayer 側で center にフォールバックする。
 */
const POSITION_ALIASES_JA: Record<string, string> = {
  左: 'left',
  左寄り: 'left',
  左端: 'left',
  中央: 'center',
  真ん中: 'center',
  まんなか: 'center',
  真中: 'center',
  中: 'center',
  右: 'right',
  右寄り: 'right',
  右端: 'right',
}

const POSITION_ALIASES_EN: Record<string, string> = {
  Left: 'left',
  Center: 'center',
  Centre: 'center',
  Right: 'right',
}

export function normalizePosition(position: string): string {
  // 空文字 / null 相当は早期に center に倒す (review #152 nit)
  if (!position) return 'center'
  return POSITION_ALIASES_JA[position] ?? POSITION_ALIASES_EN[position] ?? position
}

/** 足元 Y 座標（ダイアログボックス上端あたり） */
const CHARACTER_Y = 380

interface CharacterState {
  sprite: Sprite
  position: string
  expression: string
}

export class CharacterLayer extends Container {
  private characters: Map<string, CharacterState> = new Map()

  /**
   * キャラクター立ち絵を表示する。既に表示中なら position / expression を更新する。
   */
  show(character: string, expression: string, position: string, assetBaseUrl: string): void {
    const normalizedPosition = normalizePosition(position)
    const existing = this.characters.get(character)

    if (existing) {
      // 表情が同じで位置も同じなら何もしない
      if (existing.expression === expression && existing.position === normalizedPosition) return

      // 位置変更
      if (existing.position !== normalizedPosition) {
        const x = POSITION_X[normalizedPosition] ?? POSITION_X['center']
        existing.sprite.x = x
        existing.position = normalizedPosition
      }

      // 表情変更
      if (existing.expression !== expression) {
        this.loadTexture(existing.sprite, expression, assetBaseUrl)
        existing.expression = expression
      }
      return
    }

    // 新規表示
    const x = POSITION_X[normalizedPosition] ?? POSITION_X['center']
    const sprite = new Sprite()
    sprite.anchor.set(0.5, 1)
    sprite.x = x
    sprite.y = CHARACTER_Y
    this.addChild(sprite)

    this.characters.set(character, { sprite, position: normalizedPosition, expression })
    this.loadTexture(sprite, expression, assetBaseUrl)
  }

  /**
   * 表情のみを差し替える（位置はそのまま）
   */
  changeExpression(character: string, expression: string, assetBaseUrl: string): void {
    const state = this.characters.get(character)
    if (!state) return
    if (state.expression === expression) return
    state.expression = expression
    this.loadTexture(state.sprite, expression, assetBaseUrl)
  }

  /**
   * キャラクターを退場させる
   */
  remove(character: string): void {
    const state = this.characters.get(character)
    if (!state) return
    this.removeChild(state.sprite)
    state.sprite.destroy()
    this.characters.delete(character)
  }

  /**
   * 現在表示中のキャラクター情報を返す（スナップショット用）
   */
  getCharacterStates(): Array<{ name: string; expression: string; position: string }> {
    const result: Array<{ name: string; expression: string; position: string }> = []
    for (const [name, state] of this.characters) {
      result.push({ name, expression: state.expression, position: state.position })
    }
    return result
  }

  /**
   * 全キャラクターを削除する
   */
  clear(): void {
    for (const [, state] of this.characters) {
      this.removeChild(state.sprite)
      state.sprite.destroy()
    }
    this.characters.clear()
  }

  /**
   * テクスチャをロードして Sprite に適用する
   */
  private loadTexture(sprite: Sprite, expression: string, assetBaseUrl: string): void {
    if (!assetBaseUrl) return

    const cleanExpression = expression.replace(/^\//, '')
    const url = `${assetBaseUrl}/images/${cleanExpression}.png`

    Assets.load(url)
      .then((texture) => {
        // destroy 後に解決した場合は反映しない（UAF 防止）
        if (sprite.destroyed) return
        sprite.texture = texture
      })
      .catch((err) => {
        console.warn('[name-name] 立ち絵の読み込みに失敗: ' + url, err)
      })
  }
}
