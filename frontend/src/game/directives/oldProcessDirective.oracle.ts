/**
 * 旧 `NovelRenderer.processDirective`（#829 着手時の origin/main d4d21fd9）の参照実装 (oracle)。
 *
 * テスト専用。ディスパッチ導入前のコードのうち、領域別ハンドラへ移した分岐（ステージ系・立ち絵系・オーディオ系）を
 * 旧コードの呼び出し順・引数のまま写している。`this.xxx` を `w.xxx`（記録用の偽物）へ置き換えただけで、
 * 新しい `directives/` のコードは一切呼ばない。フロー制御系（Flag / Choice / Jump / Wait / WaitDisplayComplete）は
 * レンダラに残っており別のテストが見るため、ここには含めない。
 *
 * 旧コードで private フィールドへ代入していた箇所は、新側の `hooks` と同じ名前の記録呼び出しに写している:
 *  - `this.currentBgmPath = x`  → `w.hooks.setCurrentBgmPath(x)`
 */
import type { Event } from '../../types'
import { normalizeBackgroundFade } from '../BackgroundController'
import { ensureFontLoaded } from '../FontLoader'
import { resolveAssetUrl, resolveFontFamily } from '../novelLayout'
import {
  DEFAULT_PAPER_DOLL_OUTLINE_COLOR,
  DEFAULT_PAPER_DOLL_OUTLINE_THICKNESS,
} from '../outlineFilter'
import { selectAndShuffleSeFiles } from '../seSelection'

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface OldWorld {
  background: any
  screenEffects: any
  stage: any
  videoLayer: any
  backgroundBoardLayer: any
  propLayer: any
  curtainLayer: any
  lightingLayer: any
  eventImageLayer: any
  telopLayer: any
  characterLayer: any
  dialogBox: any
  choiceOverlay: any
  audioManager: any
  hooks: any
  env: {
    skipMode: boolean
    initialized: boolean
    assetBaseUrl: string
    fullscreenImage: boolean
    eventImageFadeMs: number
    eventImageTransitionDefault: any
    gameDefaultFontFamily: string | null
    gameDefaultFontSize: number | null
    runtimeDefaultFontFamily: string
    runtimeDefaultFontSize: number
    telopAccentColorNum: number
    telopClearEpoch: number
  }
}

/** 旧 processDirective が（フロー制御系を除いて）処理していた文字列イベント。 */
export const OLD_STRING_KEYS = ['SceneTransition', 'VideoExit', 'SpotlightOff', 'CurtainUp']

/** 旧 processDirective が（フロー制御系を除いて）処理していたオブジェクトイベントのキー。 */
export const OLD_OBJECT_KEYS = [
  'Background',
  'BackgroundBoard',
  'Prop',
  'BackgroundColor',
  'Video',
  'EventImage',
  'EventImageExit',
  'Telop',
  'Blackout',
  'CameraMode',
  'PaperDollOutline',
  'Curtain',
  'Bgm',
  'Se',
  'ExpressionChange',
  'Exit',
  'Enter',
  'Animate',
  'DialogBorderless',
  'TitleShow',
  'Label',
  'Image',
  'TextEffect',
  'Underline',
  'Shake',
  'Flash',
  'Fade',
  'Spotlight',
]

/** 旧実装。処理したら true、旧コードがフロー制御系／未知として素通ししたら false。 */
export function oldProcessDirective(event: Event, w: OldWorld): boolean {
  if (typeof event === 'string') {
    if (event === 'SceneTransition') {
      w.background.clearBackground()
      w.videoLayer.remove()
      w.backgroundBoardLayer.clear()
      w.propLayer.clear()
      w.curtainLayer.clear()
      w.hooks.setCurtainZOrder(false)
      w.lightingLayer.clear()
      w.videoLayer.remove()
      w.eventImageLayer.remove()
      w.hooks.applyEventImageVisibility()
      w.hooks.clearTelopLayer()
      w.screenEffects.setBlackout(false)
      w.screenEffects.retreatNovelScrim()
      return true
    }
    if (event === 'VideoExit') {
      w.videoLayer.remove()
      return true
    }
    if (event === 'SpotlightOff') {
      w.lightingLayer.clear()
      return true
    }
    if (event === 'CurtainUp') {
      w.curtainLayer.raise()
      return true
    }
    return false
  }
  if ('Background' in event) {
    const bg = event.Background
    w.background.setBackground(
      bg.path,
      normalizeBackgroundFade({
        top: bg.fade_top,
        bottom: bg.fade_bottom,
        left: bg.fade_left,
        right: bg.fade_right,
      }),
      bg.brightness
    )
    return true
  }
  if ('BackgroundBoard' in event) {
    const board = event.BackgroundBoard
    w.backgroundBoardLayer.add(board.path, board.depth ?? 0, w.env.assetBaseUrl)
    return true
  }
  if ('Prop' in event) {
    const prop = event.Prop
    w.propLayer.add(prop.path, prop.depth ?? 0, w.env.assetBaseUrl)
    return true
  }
  if ('BackgroundColor' in event) {
    w.background.setBackgroundColor(event.BackgroundColor.color)
    return true
  }
  if ('Video' in event) {
    const v = event.Video
    if (w.env.assetBaseUrl) {
      w.videoLayer.show(v.path, {
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
    return true
  }
  if ('EventImage' in event) {
    const ei = event.EventImage
    if (w.env.assetBaseUrl) {
      w.eventImageLayer.show(ei.path, {
        back: ei.back,
        fadeMs: ei.fade_ms ?? w.env.eventImageFadeMs,
        transition: ei.transition ?? w.env.eventImageTransitionDefault,
        effects: ei.effects ?? undefined,
        onSettled: () => w.hooks.applyEventImageVisibility(),
        onVisibilityChange: () => w.hooks.applyEventImageVisibility(),
      })
      w.hooks.applyEventImageVisibility()
      if (w.env.fullscreenImage) {
        w.dialogBox.hide()
        w.choiceOverlay.hide()
      }
    }
    return true
  }
  if ('EventImageExit' in event) {
    w.eventImageLayer.remove({ fadeMs: event.EventImageExit.fade_ms ?? w.env.eventImageFadeMs })
    w.hooks.applyEventImageVisibility()
    return true
  }
  if ('Telop' in event) {
    if (w.env.skipMode) return true
    const telop = event.Telop
    const resolvedFontFamily = resolveFontFamily(
      null,
      w.env.gameDefaultFontFamily,
      w.env.runtimeDefaultFontFamily
    )
    const fontSize = w.env.gameDefaultFontSize ?? w.env.runtimeDefaultFontSize
    const accentColor = w.env.telopAccentColorNum
    const expectedClearEpoch = w.env.telopClearEpoch
    void ensureFontLoaded(resolvedFontFamily)
      .catch((err) => {
        console.warn('[name-name] テロップ用フォントロードに失敗', resolvedFontFamily, err)
      })
      .then(() => {
        if (!w.env.initialized) return
        if (w.env.skipMode) return
        if (w.env.telopClearEpoch !== expectedClearEpoch) return
        w.telopLayer.show({
          text: telop.text,
          position: telop.position ?? 'BottomRight',
          seconds: telop.seconds ?? 4,
          kind: telop.kind ?? null,
          fontFamily: resolvedFontFamily,
          fontSize,
          accentColor,
        })
      })
    return true
  }
  if ('Blackout' in event) {
    w.screenEffects.setBlackout(event.Blackout.action === 'On')
    return true
  }
  if ('CameraMode' in event) {
    w.stage.setCamera(
      event.CameraMode.mode,
      event.CameraMode.orientation ?? 'Audience',
      event.CameraMode.elevation ?? null,
      event.CameraMode.zoom
        ? { target: event.CameraMode.zoom, strength: event.CameraMode.zoom_strength ?? null }
        : null,
      w.env.skipMode
    )
    return true
  }
  if ('PaperDollOutline' in event) {
    w.stage.setPaperDollOutline(
      event.PaperDollOutline.enabled
        ? {
            color: event.PaperDollOutline.color ?? DEFAULT_PAPER_DOLL_OUTLINE_COLOR,
            thickness: event.PaperDollOutline.thickness ?? DEFAULT_PAPER_DOLL_OUTLINE_THICKNESS,
          }
        : null
    )
    return true
  }
  if ('Curtain' in event) {
    const curtain = event.Curtain
    w.hooks.setCurtainZOrder(curtain.characters_in_front)
    w.curtainLayer.show(curtain.path, curtain.characters_in_front, w.env.assetBaseUrl)
    return true
  }
  if ('Bgm' in event) {
    if (event.Bgm.action === 'Play' && event.Bgm.path) {
      const soundUrl = resolveAssetUrl(w.env.assetBaseUrl, 'sounds', event.Bgm.path)
      w.audioManager.playBgm(soundUrl, event.Bgm.fade_ms ?? undefined)
      w.hooks.setCurrentBgmPath(event.Bgm.path)
    } else {
      if (event.Bgm.fade_ms != null) {
        w.audioManager.stopBgm(event.Bgm.fade_ms)
      } else {
        w.audioManager.stopBgm()
      }
      w.hooks.setCurrentBgmPath(null)
    }
    return true
  }
  if ('Se' in event) {
    const selected = selectAndShuffleSeFiles(event.Se.paths, event.Se.count)
    const soundUrls = selected.map((path) => resolveAssetUrl(w.env.assetBaseUrl, 'sounds', path))
    const gapMinMs = event.Se.gap_min_ms ?? 50
    const gapMaxMs = event.Se.gap_max_ms ?? 200
    w.audioManager.playSeSequence(soundUrls, gapMinMs, gapMaxMs, event.Se.fade_ms ?? undefined)
    return true
  }
  if ('ExpressionChange' in event) {
    w.characterLayer.changeExpression(
      event.ExpressionChange.character,
      event.ExpressionChange.expression,
      w.env.assetBaseUrl
    )
    w.screenEffects.retreatNovelScrim()
    return true
  }
  if ('Exit' in event) {
    const exitDirection =
      w.stage.cameraMode === 'Theater' ? (event.Exit.exit_direction ?? undefined) : undefined
    w.characterLayer.remove(event.Exit.character, {
      instant: w.env.skipMode,
      durationMsOverride: event.Exit.fade_ms ?? undefined,
      exitDirection,
    })
    return true
  }
  if ('Enter' in event) {
    const { character, expression, position, fit, enter_direction, depth } = event.Enter
    if (character && expression && position) {
      const xRatio = w.hooks.resolveNovelRoleXRatio(character)
      const enterDirection =
        w.stage.cameraMode === 'Theater' ? (enter_direction ?? undefined) : undefined
      w.characterLayer.show(character, expression, position, w.env.assetBaseUrl, {
        instant: w.env.skipMode,
        xRatio,
        fit: fit === true,
        enterDirection,
        depth: depth ?? 0,
      })
    }
    return true
  }
  if ('Animate' in event) {
    w.characterLayer.animate(event.Animate.target, {
      dx: event.Animate.dx,
      dy: event.Animate.dy,
      rotation: event.Animate.rotation,
      scale: event.Animate.scale,
      duration_ms: event.Animate.duration_ms,
      easing: event.Animate.easing,
    })
    return true
  }
  if ('DialogBorderless' in event) {
    w.dialogBox.setBorderless(event.DialogBorderless.borderless)
    return true
  }
  if ('TitleShow' in event) {
    const ts = event.TitleShow
    const font = resolveFontFamily(
      ts.font_family,
      w.env.gameDefaultFontFamily,
      w.env.runtimeDefaultFontFamily
    )
    w.characterLayer.showTitle(ts.text, font, ts.position, ts.color, {
      size: ts.size,
      x: ts.x,
      y: ts.y,
    })
    return true
  }
  if ('Label' in event) {
    const lb = event.Label
    const font = resolveFontFamily(
      lb.font_family,
      w.env.gameDefaultFontFamily,
      w.env.runtimeDefaultFontFamily
    )
    w.characterLayer.showLabel({
      id: lb.id,
      text: lb.text,
      color: lb.color,
      position: lb.position,
      size: lb.size,
      fontFamily: font,
      align: lb.align,
      after: lb.after,
      x: lb.x,
      y: lb.y,
      instant: w.env.skipMode,
    })
    return true
  }
  if ('Image' in event) {
    const im = event.Image
    w.characterLayer.showImage({
      id: im.id,
      path: im.path,
      position: im.position,
      shape: im.shape,
      size: im.size,
      x: im.x,
      y: im.y,
      assetBaseUrl: w.env.assetBaseUrl,
      instant: w.env.skipMode,
      transition: im.transition,
      fadeMs: im.fade_ms,
    })
    return true
  }
  if ('TextEffect' in event) {
    const te = event.TextEffect
    void w.characterLayer.applyTextEffect(
      te.target,
      {
        effect: te.effect,
        stagger_ms: te.stagger_ms,
        ms_per_char: te.ms_per_char,
        dx: te.dx,
        dy: te.dy,
        rotation: te.rotation,
        scale: te.scale,
        alpha: te.alpha,
        duration_ms: te.duration_ms,
        easing: te.easing,
        cursor: te.cursor,
        blink_ms: te.blink_ms,
        cursor_color: te.cursor_color,
      },
      { instant: w.env.skipMode }
    )
    return true
  }
  if ('Underline' in event) {
    const ul = event.Underline
    void w.characterLayer.applyUnderline(
      ul.target,
      {
        color: ul.color,
        thickness: ul.thickness,
        duration_ms: ul.duration_ms,
        offset: ul.offset,
        easing: ul.easing,
      },
      { instant: w.env.skipMode }
    )
    return true
  }
  if ('Shake' in event) {
    w.screenEffects.startShake(event.Shake.intensity_px, event.Shake.duration_ms)
    return true
  }
  if ('Flash' in event) {
    w.screenEffects.startFlash(
      event.Flash.color,
      event.Flash.alpha,
      event.Flash.duration_ms,
      event.Flash.area ?? null,
      event.Flash.strobe,
      event.Flash.interval_ms ?? null
    )
    return true
  }
  if ('Fade' in event) {
    w.screenEffects.startFade(
      event.Fade.target,
      event.Fade.color,
      event.Fade.from_alpha,
      event.Fade.to_alpha,
      event.Fade.duration_ms
    )
    return true
  }
  if ('Spotlight' in event) {
    w.lightingLayer.set(
      event.Spotlight.target ?? null,
      event.Spotlight.color,
      event.Spotlight.radius
    )
    return true
  }
  return false
}
