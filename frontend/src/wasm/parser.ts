import init, { parse_markdown, emit_markdown } from '../../../parser/pkg/name_name_parser.js'
import type { EventDocument, Event } from '../types'
import { canonicalizeBodyText } from '../game/textCanonical'

// WASM 本体を JS バンドルに base64 で埋め込んで fetch なしで読み込む。
// 経緯: corp proxy 配下では `/parser-pkg/*.bin` を直接 URL アクセスすると binary が
// 取れるのに、JS の fetch() 経由だとブロックページ HTML が返る事象があった
// (Accept / Sec-Fetch-Dest ヘッダで proxy が分岐していると思われる)。
// 環境差を吸収するため、開発・本番ともに ArrayBuffer をバンドルに同梱する方針に切替。
// サイズコスト: 189 KiB → base64 で約 +50%。一度きりの読み込みなので runtime 影響は無視可能。
//
// `wasm-bytes.generated.ts` は frontend/scripts/sync-wasm.mjs (predev/prebuild) が
// parser/pkg/name_name_parser_bg.wasm から自動生成する。
import { WASM_BASE64 } from './wasm-bytes.generated'

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64)
  const len = bin.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// WASM init() の重複実行を防止
let initPromise: Promise<void> | null = null

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const bytes = base64ToUint8Array(WASM_BASE64)
      await init({ module_or_path: bytes.buffer as ArrayBuffer })
    })()
  }
  await initPromise
}

/**
 * WASMが返す undefined を null に正規化する。
 * Rust の Option<T> は WASM 経由で undefined になるが、
 * frontend の types.ts では null を使っているため変換が必要。
 */
/**
 * 空文字を null に丸める。WASM が誤って `Some("")` を返した場合の防御 (#147 R1 N5)。
 *
 * 適用範囲: ランタイム側で「指定なし」と「明示的に空文字を指定」を区別する必要がない
 * オプショナルな string field 限定 (`voice_path`, `font_family`, `choice_style`, `default_bgm`, `dialog_style`, `protagonist`)。
 * 必須テキスト系（`character`, `text`, `path`）には適用しない — それらは空文字も意味のある値。
 */
function nullIfEmpty(s: string | null | undefined): string | null {
  if (s == null) return null
  return s.length === 0 ? null : s
}

function normalizeEvents(events: Event[]): Event[] {
  return events.map((event) => {
    if (typeof event === 'string') return event
    if ('Dialog' in event) {
      return {
        Dialog: {
          character: event.Dialog.character ?? null,
          expression: event.Dialog.expression ?? null,
          position: event.Dialog.position ?? null,
          // 本文の表示用ダイグラフ正準化 (#340)。Rust パーサ側と同じ挙動でここでも掛ける
          // （wasm が古い / キャッシュ経由等でも素の `--`/`…` を出さないための二段目・#308）。
          text: event.Dialog.text.map(canonicalizeBodyText),
          // voice_path / font_family は WASM 経由で undefined になるが、
          // frontend の規約に合わせ null に正規化する (#144 / #147)。
          // 空文字も null に倒す (#147 R1 N5)。
          voice_path: nullIfEmpty(event.Dialog.voice_path),
          font_family: nullIfEmpty(event.Dialog.font_family),
          // 立ち絵の明示フィット (#294)。WASM は false のとき undefined を返すため
          // 明示 boolean に正規化して normalize で落とさない（新フィールド欠落の罠回避）。
          fit: event.Dialog.fit === true,
        },
      }
    }
    if ('Narration' in event) {
      return {
        Narration: {
          // 本文の表示用ダイグラフ正準化 (#340)。Dialog と同じく二段目として掛ける。
          text: event.Narration.text.map(canonicalizeBodyText),
          voice_path: nullIfEmpty(event.Narration.voice_path),
          font_family: nullIfEmpty(event.Narration.font_family),
        },
      }
    }
    if ('Enter' in event) {
      // 無言の立ち絵登場 (#401)。Dialog と同じ立ち絵属性なので同じ規約で正規化する。
      // WASM 経由で undefined になる expression/position は null に、fit は false のとき
      // undefined を返すため明示 boolean に倒す（新フィールド欠落の罠回避・Dialog #294 と同じ）。
      return {
        Enter: {
          character: event.Enter.character,
          expression: event.Enter.expression ?? null,
          position: event.Enter.position ?? null,
          fit: event.Enter.fit === true,
        },
      }
    }
    if ('Exit' in event) {
      return {
        Exit: {
          character: event.Exit.character,
          fade_ms: event.Exit.fade_ms ?? null,
        },
      }
    }
    if ('Choice' in event) {
      // 選択肢ボタン本文も表示テキストなので正準化する (#340)。
      // text 以外（jump 等）は保持する（スプレッド）。
      return {
        Choice: {
          options: event.Choice.options.map((option) => ({
            ...option,
            text: canonicalizeBodyText(option.text),
          })),
        },
      }
    }
    if ('TitleShow' in event) {
      // タイトルカードの表示文字列を正準化する (#340)。他フィールド（色・位置・サイズ等）は保持。
      return {
        TitleShow: {
          ...event.TitleShow,
          text: canonicalizeBodyText(event.TitleShow.text),
        },
      }
    }
    if ('Label' in event) {
      // ラベルの表示文字列を正準化する (#340)。他フィールド（色・位置・id 等）は保持。
      return {
        Label: {
          ...event.Label,
          text: canonicalizeBodyText(event.Label.text),
        },
      }
    }
    if ('RpgEvent' in event) {
      // RPG イベント（[イベント]）内の会話も表示テキストなので正準化する (#340)。
      // 各コマンドの Dialog/Narration の text にだけ掛け、話者名 character・他コマンドは
      // spread で不変に保つ。RpgEvent.name も spread で保持（#308 の dropped-field 罠を避ける）。
      return {
        RpgEvent: {
          ...event.RpgEvent,
          commands: event.RpgEvent.commands.map((command) => {
            if (command.type === 'Dialog' || command.type === 'Narration') {
              return { ...command, text: command.text.map(canonicalizeBodyText) }
            }
            return command
          }),
        },
      }
    }
    if ('Background' in event) {
      // Rust 側の Option<u32> / Option<f32> は WASM 経由で undefined になるため、
      // frontend の規約（types.ts）に合わせて null に正規化する。
      // brightness 未指定（null）は原画のまま（tint=白）＝後方互換。
      const bg = event.Background
      return {
        Background: {
          path: bg.path,
          fade_top: bg.fade_top ?? null,
          fade_bottom: bg.fade_bottom ?? null,
          fade_left: bg.fade_left ?? null,
          fade_right: bg.fade_right ?? null,
          brightness: bg.brightness ?? null,
        },
      }
    }
    if ('Bgm' in event) {
      return {
        Bgm: {
          path: event.Bgm.path ?? null,
          action: event.Bgm.action,
          fade_ms: event.Bgm.fade_ms ?? null,
        },
      }
    }
    if ('Se' in event) {
      return {
        Se: {
          path: event.Se.path,
          fade_ms: event.Se.fade_ms ?? null,
        },
      }
    }
    if ('EventImage' in event) {
      // #351: Rust 側は `back: EventImageBack`（Option ではないが #[serde(default)] のため
      // tsify の型上は optional）。実運用では常に値が入るはずだが、他フィールドと同じ防御的
      // 正規化として undefined を既定値 'Hide' に倒す。fade_ms は Option<u32> なので null に倒す。
      const ei = event.EventImage
      return {
        EventImage: {
          path: ei.path,
          back: ei.back ?? 'Hide',
          fade_ms: ei.fade_ms ?? null,
        },
      }
    }
    if ('EventImageExit' in event) {
      return {
        EventImageExit: {
          fade_ms: event.EventImageExit.fade_ms ?? null,
        },
      }
    }
    if ('Condition' in event) {
      return {
        Condition: {
          flag: event.Condition.flag,
          events: normalizeEvents(event.Condition.events),
        },
      }
    }
    if ('RpgMap' in event) {
      // Issue #90: Rust 側の Option<Vec<Vec<f64>>> は WASM 経由で undefined になるため、
      // frontend の規約（types.ts）に合わせて null に正規化する。
      return {
        RpgMap: {
          width: event.RpgMap.width,
          height: event.RpgMap.height,
          tile_size: event.RpgMap.tile_size,
          tiles: event.RpgMap.tiles,
          wall_heights: event.RpgMap.wall_heights ?? null,
          floor_heights: event.RpgMap.floor_heights ?? null,
          ceiling_heights: event.RpgMap.ceiling_heights ?? null,
        },
      }
    }
    return event
  })
}

function normalizeDocument(doc: EventDocument): EventDocument {
  return {
    engine: doc.engine,
    aspect_ratio: doc.aspect_ratio,
    choice_style: nullIfEmpty(doc.choice_style),
    font_family: nullIfEmpty(doc.font_family),
    // per-game 本文フォントサイズ (#283 補遺)。数値なので nullIfEmpty（文字列用）は使わず、
    // WASM 経由の undefined を null に倒すだけ（未指定は runtime 既定 40 にフォールバック）。
    font_size: doc.font_size ?? null,
    // 会話の描画スタイル (#283)。choice_style と同じく空文字は null に倒す。
    dialog_style: nullIfEmpty(doc.dialog_style),
    // 質問役（主人公）の話者名 (#286)。choice_style と同じく空文字は null に倒す。
    protagonist: nullIfEmpty(doc.protagonist),
    // 立ち絵足元 Y 比率 (#308)。数値なので ?? null（未指定は runtime 既定 1.0）。
    character_y_ratio: doc.character_y_ratio ?? null,
    // 立ち絵の目標表示高さ比率 (#360)。数値なので ?? null（未指定は原寸 scale=1）。
    character_height_ratio: doc.character_height_ratio ?? null,
    // キャラごとの立ち絵目標表示高さ比率 override (#364)。Rust の HashMap<String, f64> は
    // tsify 経由で Map になって返るため、Record に変換する（npc.expressions と同じ変換パターン、
    // rpgProjectFromDoc.ts 参照）。未指定時は空オブジェクト（後方互換）。
    // ここを忘れると Rust 側は正しくパースされているのに wasm 経由で undefined になり、
    // テストは緑のまま本番だけ壊れる（#308 の教訓）。
    character_height_ratios: (() => {
      const m = doc.character_height_ratios as unknown as Map<string, number> | undefined
      return m && m.size > 0 ? Object.fromEntries(m) : {}
    })(),
    // 立ち絵の元絵基準スケール (#378)。数値なので ?? null（未指定は下位優先順位へフォールバック）。
    character_scale: doc.character_scale ?? null,
    character_fade_ms: doc.character_fade_ms ?? null,
    // 背景クロスフェード・退場（終劇）フェード時間 (#407)。数値なので ?? null（未指定は runtime 既定 700＝BACKGROUND_CROSSFADE_MS）。
    background_fade_ms: doc.background_fade_ms ?? null,
    // イベント絵の表示・退場フェード時間。個別 `フェード=` が無いイベント絵で使う。
    event_image_fade_ms: doc.event_image_fade_ms ?? null,
    // 下地ベタ（bgGraphics）の既定色 (#409)。文字列なので ?? null（未指定は runtime 既定の黒）。
    background_color: doc.background_color ?? null,
    // スキップ/デバッグの per-game 出し分け (#310)。boolean なので ?? null（未指定は下流で既定: skip=true / debug=false）。
    skip_enabled: doc.skip_enabled ?? null,
    debug_enabled: doc.debug_enabled ?? null,
    // 話者交代 nudge の per-game 出し分け (#382)。boolean なので ?? null（未指定は下流で既定 false＝非発火・opt-in）。
    speaker_nudge: doc.speaker_nudge ?? null,
    // オート再生の per-game 出し分け (#436)。boolean なので ?? null（未指定は下流で既定 false＝手送り）。
    auto_play: doc.auto_play ?? null,
    // SeekBar のフィル／つまみ色 (#440)。文字列なので ?? null（未指定は下流で既定の水色 #a8dadc）。
    seekbar_color: doc.seekbar_color ?? null,
    chapters: doc.chapters.map((chapter) => ({
      ...chapter,
      default_bgm: chapter.default_bgm ?? null,
      scenes: chapter.scenes.map((scene) => ({
        ...scene,
        events: normalizeEvents(scene.events),
      })),
    })),
  }
}

export async function parseMarkdown(markdown: string): Promise<EventDocument> {
  await ensureInit()
  const raw = parse_markdown(markdown) as EventDocument
  return normalizeDocument(raw)
}

// emit_markdown は将来のエディタ→Markdown変換に使用
export async function emitMarkdown(document: EventDocument): Promise<string> {
  await ensureInit()
  return emit_markdown(document)
}
