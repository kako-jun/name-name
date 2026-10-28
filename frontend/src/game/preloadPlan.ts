/**
 * 立ち絵・背景の先読み (#389) で、これから出るアセット URL を集める純粋関数 (#735 1/8, #822)。
 *
 * `preloadedUrls`（積み済み集合）との差分と `backgroundPreload()` の呼び出しは副作用なので
 * `NovelRenderer.preloadUpcomingAssets` に残し、ここは「どの URL を、どの順で」だけを決める。
 * `NovelRenderer` の `this` に依存せず、`NovelRenderer` を import しない。
 */

import type { Event } from '../types'
import { isTextEvent } from './eventCursor'
import { isWallVideoPath, resolveAssetUrl, resolveCharacterImageUrls } from './novelLayout'

/**
 * 立ち絵・背景先読み (#389) のテキストイベント数上限。旧仕様（8）は theo-hayami の実測値
 * （1話あたり Dialog 平均 13.9 件・最大 19 件、`free/` 業×住人セル 296 話計測）が上回っており、
 * 十分な読み込み時間があるにもかかわらず先読みが途中で打ち切られ立ち絵切り替えが遅延する事故を
 * 招いたため撤廃した (#417)。先読みの実質的な境界は「次の分岐（Choice/Condition）または配列末尾
 * まで」のまま変わらない（このループ構造自体は変更していない）。
 *
 * ⚠️ 無制限に安全というわけではない: 現時点で実運用中のゲームは theo-hayami のみのため撤廃の
 * 影響範囲は限定的だが、将来「分岐なしで極端に長い区間」を持つゲームが出た場合は、その時点で
 * 個別に上限を再検討する必要がある。
 */
export const PRELOAD_MAX_TEXT_EVENTS = Infinity

/**
 * `fromIndex`（今表示するイベントを含む）から前方へ走査し、次の分岐（Choice / Condition / Jump）か
 * 配列末尾までに現れるアセット URL を、近い順・重複除去済みで返す。
 *
 * - 収集対象: `Dialog` / `ExpressionChange` / `Enter` の立ち絵（`resolveCharacterImageUrls`、webp/png の
 *   複数候補）、`Background` / `BackgroundBoard` / `Wall`（画像の壁のみ）/ `StageFront` / `Floor` / `Prop` / `EventImage` / `Image`（`resolveAssetUrl`）。
 *   Dialog / Enter の立ち絵は実表示ガード（expression / position / character が全て truthy）に揃える。
 *   ExpressionChange は position を持たないので expression / character の truthy だけを見る。
 * - 分岐 / 緩い上限: 分岐に当たったら打ち切る。Jump (#725) も分岐扱い。テキストイベントが
 *   {@link PRELOAD_MAX_TEXT_EVENTS} 個を超えた時点で、次のテキストイベントに達したところで打ち切る
 *   （そこに至るまでの Background 等は積む）。
 * - 重複除去: 初出（最も近い方）を残す (#417)。
 * - ガード: `assetBaseUrl` が空なら空配列。
 */
export function collectUpcomingAssetUrls(
  events: readonly Event[],
  fromIndex: number,
  assetBaseUrl: string
): string[] {
  if (!assetBaseUrl) return []

  const urls: string[] = []
  let textEventCount = 0

  for (let i = fromIndex; i < events.length; i++) {
    const event = events[i]
    // 文字列 variant（'SceneTransition' / 'PageBreak' / 'VideoExit' 等）は分岐でも
    // テキストでも先読み対象アセットでもないので読み飛ばす。
    if (typeof event !== 'object' || event === null) continue

    // 分岐に当たったら走査終了（分岐先が確定しないと先読みできない）
    // Jump (#725) も分岐扱い: 遷移先は別シーンで、ここから先の同一配列は再生されない。
    if ('Choice' in event || 'Condition' in event || 'Jump' in event) break

    // テキストイベント数の緩い上限で打ち切る（Dialog も下でアセットを積むので判定を先に）
    if (isTextEvent(event)) {
      if (textEventCount >= PRELOAD_MAX_TEXT_EVENTS) break
      textEventCount++
    }

    if ('Dialog' in event) {
      // 実表示ガード（showCharacterFromDialog: `!expression || !position || !speaker`）に
      // 揃える＝立ち絵を実際に show する Dialog だけ先読みする。falsy チェックで空文字も弾き、
      // position も要求する（空文字 expression の無効 URL 先読みを消す）。
      const { character, expression, position } = event.Dialog
      if (expression && character && position) {
        for (const u of resolveCharacterImageUrls(assetBaseUrl, expression.replace(/^\//, ''))) {
          urls.push(u)
        }
      }
    } else if ('ExpressionChange' in event) {
      // ExpressionChange は position を持たない。expression / character の falsy チェックに
      // 揃える（空文字を弾く）。
      const { character, expression } = event.ExpressionChange
      if (expression && character) {
        for (const u of resolveCharacterImageUrls(assetBaseUrl, expression.replace(/^\//, ''))) {
          urls.push(u)
        }
      }
    } else if ('Enter' in event) {
      // 無言登場 (#401) の立ち絵も先読みする。Dialog の立ち絵と同じ実表示ガード
      // （expression / position / character が全て truthy）に揃える。
      const { character, expression, position } = event.Enter
      if (expression && character && position) {
        for (const u of resolveCharacterImageUrls(assetBaseUrl, expression.replace(/^\//, ''))) {
          urls.push(u)
        }
      }
    } else if ('Background' in event) {
      urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.Background.path))
    } else if ('BackgroundBoard' in event) {
      // 舞台構造の背景板 (#683) も背景と同じ Assets.load 遅延ロード経路（BackgroundBoardLayer.add）
      // を通るため、同じく先読み対象にする。
      urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.BackgroundBoard.path))
    } else if ('Wall' in event) {
      // 舞台の壁 (#703) の画像も背景板と同じ Assets.load 遅延ロード経路（WallLayer.show）を通るため
      // 先読み対象にする。動画の壁は `[動画:]` と同じく <video> 要素の読み込みで Assets を通らないので積まない。
      if (!isWallVideoPath(event.Wall.path)) {
        urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.Wall.path))
      }
    } else if ('StageFront' in event) {
      // 舞台前面 (#705) の画像も背景板と同じ Assets.load 遅延ロード経路（StageFrontLayer.show）を通るため先読み対象にする。
      urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.StageFront.path))
    } else if ('Floor' in event) {
      // 床 (#706 第2弾) の画像も背景板と同じ Assets.load 遅延ロード経路（FloorLayer.show）を通るため先読み対象にする。
      urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.Floor.path))
    } else if ('Prop' in event) {
      // 舞台構造の大道具 (#692) も背景板と同じ Assets.load 遅延ロード経路（PropLayer.add）
      // を通るため、同じく先読み対象にする。
      urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.Prop.path))
    } else if ('EventImage' in event) {
      // イベント絵 (#351) の先読み (#621)。EventImageLayer.show() は表示の瞬間に初めて
      // Assets.load するため、事前に温めておかないと切替時に初回コールドロード相当の
      // 遅延が出る。URL 形は EventImageLayer.buildImageUrl と同じ resolveAssetUrl(images)。
      urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.EventImage.path))
    } else if ('Image' in event) {
      // 単独画像 `[画像:]` (#274, renderOnly) も先読み対象に含める (#621)。除外する理由が
      // なく、症状報告のイベント絵切替遅延と同じ Assets.load 遅延ロードを踏むため。
      urls.push(resolveAssetUrl(assetBaseUrl, 'images', event.Image.path))
    }
  }

  // スキャン内での重複URL（同じキャラの表情が2回以上登場する等）を除去する（#417）。
  // 近い順の並びを保つため、初出（最も近い方）を残して後続の重複を落とす。
  const seen = new Set<string>()
  return urls.filter((u) => {
    if (seen.has(u)) return false
    seen.add(u)
    return true
  })
}
