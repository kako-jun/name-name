// kako-jun/name-name#310: normalizeDocument の per-game フィールド欠落回帰テスト。
//
// 背景: normalizeDocument は EventDocument をフィールド列挙で作り直す。
// この方式は新フィールドを追加したときに「列挙に書き忘れる」と WASM が parse した値を
// 黙って落とす罠がある。実際 #308 character_y_ratio / #310 skip_enabled / debug_enabled が
// 列挙漏れで /play runtime に届かず、機能が全部死んでいた。
//
// PlayerScreen.test.tsx は `vi.mock('../wasm/parser')` で normalizeDocument を飛ばすため
// この欠落を絶対に捕まえられない（実装と乖離した false-green）。
// ここでは実 parseMarkdown（WASM_BASE64 同梱・fetch 不要）を通し、frontmatter の per-game
// 設定が normalize を生き残って EventDocument に届くことを assert する。
//
// 「列挙漏れ→値が落ちる」を恒久的に縛るのが目的なので、新フィールドを足したら
// ここに 1 ケース追加する運用にする。

import { describe, expect, it } from 'vitest'
import { parseMarkdown } from './parser'

describe('parseMarkdown + normalizeDocument: per-game frontmatter fields survive normalize (#310)', () => {
  // #308 / #310 / 既存 (#283 dialog_style / #286 protagonist) をまとめて持つ最小スクリプト。
  // character_y_ratio=1.05（既定 1.0 と異なる値）/ character_fade_ms=700（既定 300 と異なる値）/
  // skip_enabled=false（既定 true と異なる）/
  // debug_enabled=true（既定 false と異なる）を明示し、normalize が値を保持することを見る。
  const markdown = [
    '---',
    'engine: name-name',
    'chapter: 1',
    'title: t',
    'character_y_ratio: 1.05',
    'character_fade_ms: 700',
    'skip_enabled: false',
    'debug_enabled: true',
    'dialog_style: novel',
    'protagonist: せお',
    '---',
    '',
    '## s',
    '',
    '**A**:',
    'x',
    '',
  ].join('\n')

  it('keeps character_y_ratio / character_fade_ms / skip_enabled / debug_enabled from frontmatter', async () => {
    const doc = await parseMarkdown(markdown)
    // ここが core: #308 / #310 のフィールドが normalize を生き残ること。
    // normalizeDocument の return から該当行を消すと undefined になり落ちる（修正前の状態）。
    expect(doc.character_y_ratio).toBe(1.05)
    expect(doc.character_fade_ms).toBe(700)
    expect(doc.skip_enabled).toBe(false)
    expect(doc.debug_enabled).toBe(true)
  })

  it('keeps existing per-game fields (dialog_style / protagonist) alongside the new ones', async () => {
    const doc = await parseMarkdown(markdown)
    // 既存フィールドが新フィールド追加で巻き込まれて落ちていないことの担保。
    expect(doc.dialog_style).toBe('novel')
    expect(doc.protagonist).toBe('せお')
  })

  it('leaves per-game fields null when frontmatter omits them (後方互換)', async () => {
    const minimal = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s',
      '',
      '**A**:',
      'x',
      '',
    ].join('\n')
    const doc = await parseMarkdown(minimal)
    // 未指定は null に正規化（runtime 既定にフォールバックする側で扱う）。
    // undefined を null に倒すこと自体も normalize の責務なので併せて縛る。
    expect(doc.character_y_ratio).toBeNull()
    expect(doc.character_fade_ms).toBeNull()
    expect(doc.skip_enabled).toBeNull()
    expect(doc.debug_enabled).toBeNull()
  })
})
