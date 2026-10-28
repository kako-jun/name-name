/**
 * ステージ系ディレクティブ (#829)。背景・背景板・大道具・動画・イベント絵・テロップ・幕・照明・画面効果・
 * カメラ・紙人形輪郭・文字窓の枠。旧 `NovelRenderer.processDirective` の該当分岐を、呼び出しの順序・引数ごと移したもの。
 */
import { normalizeBackgroundFade } from '../BackgroundController'
import { ensureFontLoaded } from '../FontLoader'
import { resolveFontFamily } from '../novelLayout'
import {
  DEFAULT_PAPER_DOLL_OUTLINE_COLOR,
  DEFAULT_PAPER_DOLL_OUTLINE_THICKNESS,
} from '../outlineFilter'
import { on, type DirectiveHandler, type DirectiveTable, type ObjectDirectiveTable } from './types'

/** 場面転換 `[場面転換]`。クリア対象と順序は旧 processDirective の SceneTransition 分岐と同じ（新規開始の `resetAndStartEvents` よりクリア対象は狭い）。 */
const sceneTransition: DirectiveHandler = (_event, ctx) => {
  const { stage, layers, hooks } = ctx
  stage.background.clearBackground()
  // 動画レイヤも背景と同じ扱いでクリアする (#252)。
  layers.video.remove()
  // 舞台構造の背景板 (#683) も既存の単一スロット背景と同じタイミングでクリアする。
  layers.backgroundBoard.clear()
  // 舞台の壁 (#703) も背景板と同じタイミングでクリアする。
  layers.wall.clear()
  // 舞台前面 (#705) も背景板と同じタイミングでクリアする。
  layers.stageFront.clear()
  // 天候 (#706) も背景板と同じタイミングでクリアする。
  layers.weather.clear()
  // 舞台構造の大道具 (#692) も背景板と同じタイミングでクリアする。
  layers.prop.clear()
  // 幕 (#697) も背景板・大道具と同じ単一スロット持続規律（[場面転換] でクリア、
  // 通常のシーン間ジャンプでは持ち越し）。z-order も既定位置へ戻す。
  layers.curtain.clear()
  hooks.setCurtainZOrder(false)
  // 追うスポットライト (#693) も同じタイミングで消灯する（resetAndStartEvents と同じ規律）。
  layers.lighting.clear()
  // 場面転換では動画レイヤも背景と同じ扱いでクリアする (#252)
  layers.video.remove()
  // イベント絵レイヤーも場面転換でクリアする (#351)。作者が [イベント絵終了] を書き忘れても
  // 全背面レイヤー（背景・背景板・動画・立ち絵・大道具）が隠れたまま次のシーンに
  // 持ち越されないようにする防御。
  layers.eventImage.remove()
  hooks.applyEventImageVisibility()
  // テロップ (#674) も場面転換でクリアする（eventImageLayer と同じ防御）。
  hooks.clearTelopLayer()
  stage.effects.setBlackout(false)
  // novel: 場面転換でスクリム+文字を退避して新しい絵を見せ、戻す (#283)
  stage.effects.retreatNovelScrim()
}

/** 文字列イベント（引数なしの合図）。表のキーは `Event` の文字列そのもの。 */
export const stageSignalDirectives: DirectiveTable = {
  SceneTransition: sceneTransition,

  // [動画退場] で動画レイヤをクリア (#252)
  VideoExit: (_event, ctx) => {
    ctx.layers.video.remove()
  },

  // [壁: なし] で壁をクリア (#703)
  WallExit: (_event, ctx) => {
    ctx.layers.wall.clear()
  },

  // [舞台前面: なし] で舞台前面をクリア (#705)
  StageFrontExit: (_event, ctx) => {
    ctx.layers.stageFront.clear()
  },

  // [天候: なし] で天候をクリア (#706)
  WeatherExit: (_event, ctx) => {
    ctx.layers.weather.clear()
  },

  // スポットライト消灯 (#693)。settled state（fire-and-forget ではない）。
  SpotlightOff: (_event, ctx) => {
    ctx.layers.lighting.clear()
  },

  // 幕を上げる (#697)。settled state は raise() 内で即座に null になる（上昇アニメーション自体は
  // 演出の中間状態、ADR-0002）。z-order はそのままでよい（次の [幕:] の setCurtainZOrder で改めて決まる）。
  CurtainUp: (_event, ctx) => {
    ctx.layers.curtain.raise()
  },
}

/** オブジェクトイベント。表のキーは `{ キー: ... }` のキー。 */
export const stageDirectives: ObjectDirectiveTable = {
  Background: on<'Background'>((event, ctx) => {
    const bg = event.Background
    ctx.stage.background.setBackground(
      bg.path,
      normalizeBackgroundFade({
        top: bg.fade_top,
        bottom: bg.fade_bottom,
        left: bg.fade_left,
        right: bg.fade_right,
      }),
      bg.brightness
    )
  }),

  // 舞台構造の背景板 (#683)。既存の単一スロット背景とは独立した加算的な仕組み:
  // 同じシーン内で複数回発火すれば、それぞれ別の板として蓄積される。
  BackgroundBoard: on<'BackgroundBoard'>((event, ctx) => {
    const board = event.BackgroundBoard
    if (board.flip_from) {
      // 面の切り替え (#704): 同じ depth の旧い面を差し替える（シアターは回転、それ以外は即時）。
      ctx.layers.backgroundBoard.replace(
        board.path,
        board.depth ?? 0,
        board.flip_from,
        ctx.env.assetBaseUrl,
        { flipMs: board.flip_ms, skip: ctx.env.skipMode }
      )
    } else {
      ctx.layers.backgroundBoard.add(board.path, board.depth ?? 0, ctx.env.assetBaseUrl)
    }
  }),

  // 舞台の壁 (#703)。背景板より奥の単一スロット（新しい [壁:] が前の壁を置換）。
  Wall: on<'Wall'>((event, ctx) => {
    const wall = event.Wall
    ctx.layers.wall.show(wall.path, { loop: wall.loop, mute: wall.mute }, ctx.env.assetBaseUrl)
  }),

  // 舞台前面 (#705)。画面最下部の単一スロット画像（新しい [舞台前面:] が前のを置換）。
  StageFront: on<'StageFront'>((event, ctx) => {
    ctx.layers.stageFront.show(event.StageFront.path, ctx.env.assetBaseUrl)
  }),

  // 天候 (#706)。画面空間の単一スロット（新しい [天候:] が前のを置換）。
  Weather: on<'Weather'>((event, ctx) => {
    ctx.layers.weather.set(event.Weather.kind, event.Weather.intensity ?? 1)
  }),

  // 舞台構造の大道具 (#692)。背景板とは独立した加算的レイヤー。
  Prop: on<'Prop'>((event, ctx) => {
    const prop = event.Prop
    if (prop.flip_from) {
      // 面の切り替え (#704): 背景板と同じ。
      ctx.layers.prop.replace(prop.path, prop.depth ?? 0, prop.flip_from, ctx.env.assetBaseUrl, {
        flipMs: prop.flip_ms,
        skip: ctx.env.skipMode,
      })
    } else {
      ctx.layers.prop.add(prop.path, prop.depth ?? 0, ctx.env.assetBaseUrl)
    }
  }),

  // 単色地色 (#273)。背景画像と同じ永続状態（snapshot / applyState / セーブ復元で復元）。
  BackgroundColor: on<'BackgroundColor'>((event, ctx) => {
    ctx.stage.background.setBackgroundColor(event.BackgroundColor.color)
  }),

  // 動画入力レイヤ (#252)。URL 構築は VideoLayer 側に委譲し、相対パスをそのまま渡す。
  Video: on<'Video'>((event, ctx) => {
    const v = event.Video
    if (ctx.env.assetBaseUrl) {
      ctx.layers.video.show(v.path, {
        position: v.position,
        scale: v.scale,
        loop: v.loop,
        mute: v.mute,
        fade: normalizeBackgroundFade({
          top: v.fade_top,
          bottom: v.fade_bottom,
          left: v.fade_left,
          right: v.fade_right,
        }),
      })
    }
  }),

  // イベント絵レイヤー (#351)。表示後、全背面レイヤーの可視性を back 値に応じて宣言的に更新する
  // （applyEventImageVisibility は processDirective / applyState の両方から呼ばれる単一の宣言的トグル・ADR-0002）。
  // onSettled でロード完了/失敗後にも再計算する（ロード失敗のまま back=Hide が残る事故を防ぐ）。
  EventImage: on<'EventImage'>((event, ctx) => {
    const ei = event.EventImage
    const { env, layers, hooks } = ctx
    if (!env.assetBaseUrl) return
    layers.eventImage.show(ei.path, {
      back: ei.back,
      fadeMs: ei.fade_ms ?? env.eventImageFadeMs,
      // 遷移モード (#583)。parser が実効デフォルトへ解決済みだが、念のため ?? で防御する。
      transition: ei.transition ?? env.eventImageTransitionDefault,
      // アンビエント演出 (#582)。
      effects: ei.effects ?? undefined,
      onSettled: () => hooks.applyEventImageVisibility(),
      onVisibilityChange: () => hooks.applyEventImageVisibility(),
    })
    hooks.applyEventImageVisibility()
    // フルキャンバス画像表示モード (#530): テキストウィンドウ/選択肢を隠す。次の Dialog/Narration や
    // 選択肢表示で通常どおり再表示される（可逆トグル）。
    if (env.fullscreenImage) {
      layers.dialogBox.hide()
      layers.choiceOverlay.hide()
    }
  }),

  // [イベント絵終了] でイベント絵レイヤーをクリアする (#351)。
  EventImageExit: on<'EventImageExit'>((event, ctx) => {
    ctx.layers.eventImage.remove({
      fadeMs: event.EventImageExit.fade_ms ?? ctx.env.eventImageFadeMs,
    })
    ctx.hooks.applyEventImageVisibility()
  }),

  // 汎用テロップ (#674)。スキップ中は表示しない（ADR-0002: 演出の中間状態を作らない）。復元は applyState の
  // 宣言的復元経由でこのイベント自体を通らないため個別ガードは不要（NovelGameState には持たせない設計）。
  Telop: on<'Telop'>((event, ctx) => {
    const { env, layers } = ctx
    if (env.skipMode) return
    const telop = event.Telop
    const resolvedFontFamily = resolveFontFamily(
      null,
      env.gameDefaultFontFamily,
      env.runtimeDefaultFontFamily
    )
    const fontSize = env.gameDefaultFontSize ?? env.runtimeDefaultFontSize
    const accentColor = env.telopAccentColorNum
    // フォント未ロードのまま show() すると、その時点のフォールバックフォントの字形幅で折り返し・帯の高さが
    // 確定してしまうため、ensureFontLoaded() の完了を待ってから show() する（#679）。fire-and-forget。
    const expectedClearEpoch = env.telopClearEpoch
    void ensureFontLoaded(resolvedFontFamily)
      .catch((err) => {
        // ロード失敗時もフォールバックフォントで表示は続行する（.then は必ず走る）。
        console.warn('[name-name] テロップ用フォントロードに失敗', resolvedFontFamily, err)
      })
      .then(() => {
        // 待機中にシーン切替/goBack/seekTo/セーブ復元・スキップ開始・破棄が起きていたら古いテロップを出さない。
        if (!env.initialized) return
        if (env.skipMode) return
        if (env.telopClearEpoch !== expectedClearEpoch) return
        layers.telop.show({
          text: telop.text,
          position: telop.position ?? 'BottomRight',
          seconds: telop.seconds ?? 4,
          kind: telop.kind ?? null,
          fontFamily: resolvedFontFamily,
          fontSize,
          accentColor,
        })
      })
  }),

  Blackout: on<'Blackout'>((event, ctx) => {
    ctx.stage.effects.setBlackout(event.Blackout.action === 'On')
  }),

  // #681/#682: GameState 更新と、背景板・大道具・立ち絵への再配置の伝播は `stage.setCamera` が行う。
  // orientation 省略/未知値は客席相当（'Audience'）、elevation 省略/未知値は水平相当（null）。
  // 進行中の stageMotion（歩行入場/退場、#684）は setCamera の再適用対象外（#684 時点からの既知の割り切り）。
  CameraMode: on<'CameraMode'>((event, ctx) => {
    ctx.stage.setCamera(
      event.CameraMode.mode,
      event.CameraMode.orientation ?? 'Audience',
      event.CameraMode.elevation ?? null,
      event.CameraMode.zoom
        ? { target: event.CameraMode.zoom, strength: event.CameraMode.zoom_strength ?? null }
        : null,
      // スキップ中は寄り・戻りの補間を飛ばして最終状態へ即時スナップする (#702、ADR-0002)。
      ctx.env.skipMode
    )
  }),

  // #699: スコープはキャラクター個別ではなくシナリオ全体（場面転換で自動クリアしない）。
  // color/thickness 省略時は runtime 側の既定値（白・太さ2）。立ち絵・大道具の両方へ伝わる。
  PaperDollOutline: on<'PaperDollOutline'>((event, ctx) => {
    ctx.stage.setPaperDollOutline(
      event.PaperDollOutline.enabled
        ? {
            color: event.PaperDollOutline.color ?? DEFAULT_PAPER_DOLL_OUTLINE_COLOR,
            thickness: event.PaperDollOutline.thickness ?? DEFAULT_PAPER_DOLL_OUTLINE_THICKNESS,
          }
        : null
    )
  }),

  // 幕を降ろす (#697)。settled state。z-order を characters_in_front に合わせてから表示する。
  Curtain: on<'Curtain'>((event, ctx) => {
    const curtain = event.Curtain
    ctx.hooks.setCurtainZOrder(curtain.characters_in_front)
    ctx.layers.curtain.show(curtain.path, curtain.characters_in_front, ctx.env.assetBaseUrl)
  }),

  // 追うスポットライト点灯 (#693)。settled state（fire-and-forget ではない）。
  Spotlight: on<'Spotlight'>((event, ctx) => {
    ctx.layers.lighting.set(
      event.Spotlight.target ?? null,
      event.Spotlight.color,
      event.Spotlight.radius
    )
  }),

  // 画面シェイク (#143) — fire-and-forget
  Shake: on<'Shake'>((event, ctx) => {
    ctx.stage.effects.startShake(event.Shake.intensity_px, event.Shake.duration_ms)
  }),

  // フラッシュ (#143) — fire-and-forget。エリア限定・ストロボは #693 拡張。
  Flash: on<'Flash'>((event, ctx) => {
    ctx.stage.effects.startFlash(
      event.Flash.color,
      event.Flash.alpha,
      event.Flash.duration_ms,
      event.Flash.area ?? null,
      event.Flash.strobe,
      event.Flash.interval_ms ?? null
    )
  }),

  // フェード (#143) — fire-and-forget
  Fade: on<'Fade'>((event, ctx) => {
    ctx.stage.effects.startFade(
      event.Fade.target,
      event.Fade.color,
      event.Fade.from_alpha,
      event.Fade.to_alpha,
      event.Fade.duration_ms
    )
  }),

  // 文字ウィンドウ枠の ON/OFF (#135)
  DialogBorderless: on<'DialogBorderless'>((event, ctx) => {
    ctx.layers.dialogBox.setBorderless(event.DialogBorderless.borderless)
  }),
}
