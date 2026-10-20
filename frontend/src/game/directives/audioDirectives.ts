/**
 * オーディオ系ディレクティブ (#829)。BGM と SE。旧 `NovelRenderer.processDirective` の該当分岐を移したもの。
 */
import { resolveAssetUrl } from '../novelLayout'
import { selectAndShuffleSeFiles } from '../seSelection'
import { on, type DirectiveTable } from './types'

export const audioDirectives: DirectiveTable = {
  Bgm: on<'Bgm'>((event, ctx) => {
    const { audio, env, hooks } = ctx
    if (event.Bgm.action === 'Play' && event.Bgm.path) {
      const soundUrl = resolveAssetUrl(env.assetBaseUrl, 'sounds', event.Bgm.path)
      // fade_ms (#145): 指定があれば fade-in、未指定なら即時再生
      audio.playBgm(soundUrl, event.Bgm.fade_ms ?? undefined)
      hooks.setCurrentBgmPath(event.Bgm.path)
    } else {
      // fade_ms (#145): 指定があればその ms で fade-out、未指定は AudioManager 既定 (1000ms)
      if (event.Bgm.fade_ms != null) {
        audio.stopBgm(event.Bgm.fade_ms)
      } else {
        audio.stopBgm()
      }
      hooks.setCurrentBgmPath(null)
    }
  }),

  // paths が1件のみなら従来通りの単発再生（後方互換）。複数件ならランダム抽出+シャッフル+ランダム間隔の
  // 再生プールとして扱う (#672)。選択・シャッフルはトリガ発火時に毎回新たに計算し、GameState 等の
  // 永続構造には焼き込まない（doctrine 規律3）。
  Se: on<'Se'>((event, ctx) => {
    const selected = selectAndShuffleSeFiles(event.Se.paths, event.Se.count)
    const soundUrls = selected.map((path) => resolveAssetUrl(ctx.env.assetBaseUrl, 'sounds', path))
    // 間隔省略時のランタイム既定 50-200ms (#672 Issue本文)
    const gapMinMs = event.Se.gap_min_ms ?? 50
    const gapMaxMs = event.Se.gap_max_ms ?? 200
    // fade_ms (#145): 指定があれば各再生に fade-in、未指定なら即時再生
    ctx.audio.playSeSequence(soundUrls, gapMinMs, gapMaxMs, event.Se.fade_ms ?? undefined)
  }),
}
