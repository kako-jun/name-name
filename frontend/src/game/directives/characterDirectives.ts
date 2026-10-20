/**
 * 立ち絵系ディレクティブ (#829)。立ち絵の登場・退場・表情・アニメと、`CharacterLayer` が描く
 * タイトル・ラベル・画像・グリフ演出・下線。旧 `NovelRenderer.processDirective` の該当分岐を移したもの。
 *
 * 立ち絵ロード待ち（`showCharacterThenRender`・#293）はレンダラに残る。ここは Dialog の立ち絵ではなく
 * 無言の `[登場:]` などを `CharacterLayer` へ渡すだけで、`lastSpeaker` / 話者交代 nudge には触れない。
 */
import { resolveFontFamily } from '../novelLayout'
import { on, type DirectiveTable } from './types'

export const characterDirectives: DirectiveTable = {
  ExpressionChange: on<'ExpressionChange'>((event, ctx) => {
    ctx.characters.changeExpression(
      event.ExpressionChange.character,
      event.ExpressionChange.expression,
      ctx.env.assetBaseUrl
    )
    // novel: 表情変化でスクリム+文字を退避して立ち絵の変化を見せ、戻す (#283)
    ctx.stage.effects.retreatNovelScrim()
  }),

  Exit: on<'Exit'>((event, ctx) => {
    // スキップモード中はフェードを抑制して即時退場（既読を素早く流す UX に揃える）#177
    // 方向モーション (#684): シアターモードのときだけ方向引数を反映する。ノベルモードでは
    // 無視して従来通りのフェード退場にフォールバックする（#681 の cameraMode を参照して分岐）。
    const exitDirection =
      ctx.stage.cameraMode === 'Theater' ? (event.Exit.exit_direction ?? undefined) : undefined
    ctx.characters.remove(event.Exit.character, {
      instant: ctx.env.skipMode,
      durationMsOverride: event.Exit.fade_ms ?? undefined,
      exitDirection,
    })
  }),

  // 無言の立ち絵登場 (#401)。`[登場: 名前 (sprite/表情, 位置)]`。Dialog 経由の showCharacterFromDialog と同じ
  // show ロジック（役割配置の xRatio / fit / skip 中の即時表示）だが、本文を持たないため lastSpeaker 追跡・
  // nudge・scrim 退避は行わない。expression / position / character が揃っていない指定は silent skip。
  // 冪等: 同一 name/expression/position/fit の再宣言は CharacterLayer.show 側の no-op ガードで無効。
  Enter: on<'Enter'>((event, ctx) => {
    const { character, expression, position, fit, enter_direction, depth } = event.Enter
    if (character && expression && position) {
      const xRatio = ctx.hooks.resolveNovelRoleXRatio(character)
      // 方向モーション (#684): シアターモードのときだけ方向引数を反映する。
      const enterDirection =
        ctx.stage.cameraMode === 'Theater' ? (enter_direction ?? undefined) : undefined
      ctx.characters.show(character, expression, position, ctx.env.assetBaseUrl, {
        instant: ctx.env.skipMode,
        xRatio,
        fit: fit === true,
        enterDirection,
        // シアターモードの奥行き配置 (#694)。未指定/null は 0（最前面）。
        depth: depth ?? 0,
      })
    }
  }),

  // 立ち絵アニメ (#134) — fire-and-forget。完了を待たず次へ進む。
  Animate: on<'Animate'>((event, ctx) => {
    ctx.characters.animate(event.Animate.target, {
      dx: event.Animate.dx,
      dy: event.Animate.dy,
      rotation: event.Animate.rotation,
      scale: event.Animate.scale,
      duration_ms: event.Animate.duration_ms,
      easing: event.Animate.easing,
    })
  }),

  // 動画タイトル中央表示 (llll-ll-media 用)。フォント解決の優先順チェーンは resolveFontFamily (#260)。
  // 文字色 (#273) は CharacterLayer 側で解決し、サイズ・x/y override (#275) も渡す。
  TitleShow: on<'TitleShow'>((event, ctx) => {
    const ts = event.TitleShow
    const font = resolveFontFamily(
      ts.font_family,
      ctx.env.gameDefaultFontFamily,
      ctx.env.runtimeDefaultFontFamily
    )
    ctx.characters.showTitle(ts.text, font, ts.position, ts.color, {
      size: ts.size,
      x: ts.x,
      y: ts.y,
    })
  }),

  // 単独の色付きラベル (#274) — OP タイトルカードの肩書 / 名前。フォント解決は TitleShow と共通。
  // 揃え・隣接・x/y override (#275) もそのまま渡す。skipMode 中はフェードインを飛ばして即時表示。
  Label: on<'Label'>((event, ctx) => {
    const lb = event.Label
    const font = resolveFontFamily(
      lb.font_family,
      ctx.env.gameDefaultFontFamily,
      ctx.env.runtimeDefaultFontFamily
    )
    ctx.characters.showLabel({
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
      instant: ctx.env.skipMode,
    })
  }),

  // 単独の画像 (#274) — OP タイトルカードのアバター。url 解決は背景画像と同じ assetBaseUrl + '/images/' + path。
  // 遷移モード・所要時間 (#628) は im.transition をそのまま渡す（EventImage と違い defaultTransition は適用しない）。
  Image: on<'Image'>((event, ctx) => {
    const im = event.Image
    ctx.characters.showImage({
      id: im.id,
      path: im.path,
      position: im.position,
      shape: im.shape,
      size: im.size,
      // 位置 override (#275)。position トークンより優先。
      x: im.x,
      y: im.y,
      assetBaseUrl: ctx.env.assetBaseUrl,
      instant: ctx.env.skipMode,
      transition: im.transition,
      fadeMs: im.fade_ms,
    })
  }),

  // グリフ単位の文字演出 (#268) — fire-and-forget。skipMode 中は演出を畳んで即時完了（ADR 0002）。
  TextEffect: on<'TextEffect'>((event, ctx) => {
    const te = event.TextEffect
    void ctx.characters.applyTextEffect(
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
        // #271 点滅カーソル（効果=タイプ 専用）
        cursor: te.cursor,
        blink_ms: te.blink_ms,
        cursor_color: te.cursor_color,
      },
      { instant: ctx.env.skipMode }
    )
  }),

  // 下線ビーム (#270) — fire-and-forget。skipMode 中は伸び切った静止線にする（ADR0002）。
  Underline: on<'Underline'>((event, ctx) => {
    const ul = event.Underline
    void ctx.characters.applyUnderline(
      ul.target,
      {
        color: ul.color,
        thickness: ul.thickness,
        duration_ms: ul.duration_ms,
        offset: ul.offset,
        easing: ul.easing,
      },
      { instant: ctx.env.skipMode }
    )
  }),
}
