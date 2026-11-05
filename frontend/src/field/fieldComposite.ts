/**
 * フィールド最終合成の箱 (#885)。world（背景・キャラ・前景・感情吹き出し）を 1 つの Container に束ね、
 * enabled のときだけそこへチルトシフトを 1 回掛ける。
 * world は揺れ（world.y）で動くので、フィルタ領域は揺れない外側の箱に画面固定で持つ（syncArea で画面サイズに合わせ直す）。
 * 会話窓・フェード・戦闘画面は箱の外に置く（呼び出し側の責務）。
 */
import { Container, Rectangle } from 'pixi.js'
import { TiltShiftFilter } from '../game/TiltShiftFilter'

export interface FieldComposite {
  composite: Container
  /** 画面サイズが変わったとき（リサイズ・初期化後）に呼ぶ。フィルタが無ければ何もしない */
  syncArea: () => void
}

export function buildFieldComposite(
  world: Container,
  enabled: boolean,
  screen: { width: number; height: number }
): FieldComposite {
  const composite = new Container()
  composite.addChild(world)
  const syncArea = (): void => {
    if (composite.filters) {
      composite.filterArea = new Rectangle(0, 0, screen.width, screen.height)
    }
  }
  if (enabled) {
    composite.filters = [new TiltShiftFilter()]
    syncArea()
  }
  return { composite, syncArea }
}
