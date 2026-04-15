import init, { parse_markdown, emit_markdown } from '../../../parser/pkg/name_name_parser.js'
import type { EventDocument } from '../types'

let initialized = false

async function ensureInit(): Promise<void> {
  if (initialized) return
  await init()
  initialized = true
}

export async function parseMarkdown(markdown: string): Promise<EventDocument> {
  await ensureInit()
  return parse_markdown(markdown) as EventDocument
}

export async function emitMarkdown(document: EventDocument): Promise<string> {
  await ensureInit()
  return emit_markdown(document)
}
