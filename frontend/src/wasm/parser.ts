import init, { parse_markdown, emit_markdown } from '../../../parser/pkg/name_name_parser.js'
import type { EventDocument, Event } from '../types'

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
function normalizeEvents(events: Event[]): Event[] {
  return events.map((event) => {
    if (typeof event === 'string') return event
    if ('Dialog' in event) {
      return {
        Dialog: {
          character: event.Dialog.character ?? null,
          expression: event.Dialog.expression ?? null,
          position: event.Dialog.position ?? null,
          text: event.Dialog.text,
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
