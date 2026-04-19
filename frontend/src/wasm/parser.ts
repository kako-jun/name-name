import init, { parse_markdown, emit_markdown } from '../../../parser/pkg/name_name_parser.js'
import type { EventDocument, Event } from '../types'

// WASM init() の重複実行を防止
let initPromise: Promise<void> | null = null

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = init().then(() => {})
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
