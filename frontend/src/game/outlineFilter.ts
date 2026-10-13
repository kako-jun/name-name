/**
 * 紙人形風の輪郭フィルタ (#699)。
 *
 * `[紙人形輪郭: オン]` / `[紙人形輪郭: オフ]` の settled state（`NovelGameState.paperDollOutline`）
 * を実際の `pixi-filters` `OutlineFilter` へ変換する生成ロジックを1箇所に切り出す
 * （dev-doctrine 規律4: 計算・生成ロジックを専用モジュールに切り出す。`CharacterLayer`/
 * `PropLayer` 本体には直書きしない）。
 *
 * `CharacterLayer`/`PropLayer` はどちらもこのモジュールの `PaperDollOutlineConfig` 型と
 * `createPaperDollOutlineFilter` を使い、同じ色・太さの輪郭を共有する（キャラクター単位ではなく
 * シナリオ全体で1つの見た目に揃える設計、Issue #699 方針）。
 */
import { OutlineFilter } from 'pixi-filters'

/** 紙人形輪郭の settled 設定。`Event::PaperDollOutline` の `color`/`thickness` を
 *  runtime 側の既定値で解決済みの値として保持する（`NovelGameState.paperDollOutline` と同形）。 */
export interface PaperDollOutlineConfig {
  color: string
  thickness: number
}

/** `[紙人形輪郭: オン]` の `color=` 省略時の既定値 (#699)。parser 側 `Event::PaperDollOutline.color`
 *  が `None` のときの意味と同じ値。 */
export const DEFAULT_PAPER_DOLL_OUTLINE_COLOR = '#ffffff'

/** `[紙人形輪郭: オン]` の `width=` 省略時の既定値 (#699)。parser 側 `Event::PaperDollOutline.thickness`
 *  が `None` のときの意味と同じ値。 */
export const DEFAULT_PAPER_DOLL_OUTLINE_THICKNESS = 2

/**
 * 紙人形風の輪郭フィルタを生成する (#699)。`OutlineFilter` は `ColorSource` として hex 文字列
 * (`"#ffffff"`) をそのまま受理するため、数値変換は行わない。
 *
 * 呼び出し側（`CharacterLayer`/`PropLayer`）は `config` が変わるたびに新しいインスタンスを
 * 作り直し、レイヤー内の全スプライトへ同じインスタンスを使い回す（キャラクター毎に別インスタンス
 * を持つ必要はない——色・太さはシナリオ全体で単一の値のため）。
 */
export function createPaperDollOutlineFilter(config: PaperDollOutlineConfig): OutlineFilter {
  return new OutlineFilter({
    thickness: config.thickness,
    color: config.color,
  })
}
