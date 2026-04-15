/**
 * 立ち絵表示レイヤー
 *
 * PixiJS Container 上でキャラクター立ち絵の表示・表情変更・退場を管理する。
 */

import { Container, Sprite, Texture } from 'pixi.js'

/** キャラクターの画面上の配置位置 */
const POSITION_X: Record<string, number> = {
  left: 150,
  center: 400,
  right: 650,
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
    const existing = this.characters.get(character)

    if (existing) {
      // 表情が同じで位置も同じなら何もしない
      if (existing.expression === expression && existing.position === position) return

      // 位置変更
      if (existing.position !== position) {
        const x = POSITION_X[position] ?? POSITION_X['center']
        existing.sprite.x = x
        existing.position = position
      }

      // 表情変更
      if (existing.expression !== expression) {
        this.loadTexture(existing.sprite, expression, assetBaseUrl)
        existing.expression = expression
      }
      return
    }

    // 新規表示
    const x = POSITION_X[position] ?? POSITION_X['center']
    const sprite = new Sprite()
    sprite.anchor.set(0.5, 1)
    sprite.x = x
    sprite.y = CHARACTER_Y
    this.addChild(sprite)

    this.characters.set(character, { sprite, position, expression })
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

    const texture = Texture.from(url)
    texture.source.on('loaded', () => {
      sprite.texture = texture
    })
    texture.source.on('error', () => {
      console.warn(`[name-name] 立ち絵の読み込みに失敗: ${url}`)
    })
  }
}
