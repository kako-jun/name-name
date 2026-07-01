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

describe('parseMarkdown + normalizeEvents: 表示テキストの正準化 (#340)', () => {
  // 実 parse（Rust wasm）→ normalizeEvents（JS 二段目）を通し、読ませる表示テキスト
  // （Dialog/Narration/Choice/TitleShow/Label）が中央字へ正準化されること、RPG マスタ名は
  // 不変であることを縛る。#308 の二段漏れ（片側だけ直して素の値が出る）を恒久的に防ぐ。
  const markdown = [
    '---',
    'engine: name-name',
    'chapter: 1',
    'title: t',
    '---',
    '',
    '## data: マスター',
    '',
    '[モンスター boss--1]',
    '名前: 王--様',
    'HP: 10',
    'ATK: 3',
    'DEF: 1',
    'AGI: 2',
    'EXP: 2',
    'GOLD: 1',
    '[/モンスター]',
    '',
    '## s1: シーン',
    '',
    '[タイトル: orber--now]',
    '',
    '[ラベル: kako--jun, 位置=中]',
    '',
    '**A**:',
    '待って--行かないで…',
    '',
    '> 風が吹いた--そして…',
    '',
    '[選択]',
    '- 行く--戻る → a',
    '- そう…だね → b',
    '[/選択]',
    '',
  ].join('\n')

  const collectEvents = (doc: Awaited<ReturnType<typeof parseMarkdown>>) =>
    doc.chapters.flatMap((c) => c.scenes.flatMap((s) => s.events))

  it('Dialog / Narration / Choice / TitleShow / Label を中央字に正準化する', async () => {
    const events = collectEvents(await parseMarkdown(markdown))
    const dialog = events.find((e) => typeof e === 'object' && 'Dialog' in e)
    const narration = events.find((e) => typeof e === 'object' && 'Narration' in e)
    const choice = events.find((e) => typeof e === 'object' && 'Choice' in e)
    const title = events.find((e) => typeof e === 'object' && 'TitleShow' in e)
    const label = events.find((e) => typeof e === 'object' && 'Label' in e)

    expect(dialog && 'Dialog' in dialog && dialog.Dialog.text).toEqual(['待って──行かないで⋯'])
    expect(narration && 'Narration' in narration && narration.Narration.text).toEqual([
      '風が吹いた──そして⋯',
    ])
    expect(choice && 'Choice' in choice && choice.Choice.options.map((o) => o.text)).toEqual([
      '行く──戻る',
      'そう⋯だね',
    ])
    expect(title && 'TitleShow' in title && title.TitleShow.text).toBe('orber──now')
    expect(label && 'Label' in label && label.Label.text).toBe('kako──jun')
  })

  it('RPG マスタ名（Monster の name/id）は不変', async () => {
    const events = collectEvents(await parseMarkdown(markdown))
    const monster = events.find((e) => typeof e === 'object' && 'Monster' in e)
    expect(monster && 'Monster' in monster && monster.Monster.name).toBe('王--様')
    expect(monster && 'Monster' in monster && monster.Monster.id).toBe('boss--1')
  })
})

describe('parseMarkdown 表示テキスト正準化のスコープガード end-to-end (#340)', () => {
  // 実 parse（Rust wasm）→ normalizeEvents（JS 二段目）を単一 .md フィクスチャで通し、
  // 「読ませる本文だけ正準化・それ以外（frontmatter / 見出し / 話者名 / アセットパス / 3連ハイフン /
  // 単独 --- 改頁）は不変」を 1 観点ずつ縛る。#308 の二段漏れ（片側だけ直して素の値が出る）と、
  // markdown hr との衝突（3連/単独 ---）を end-to-end で恒久固定する。
  const markdown = [
    '---',
    'engine: name-name',
    'chapter: 1',
    'title: a--b', // C8: chapter.title は不変（frontmatter 値・フェンス破綻せず parse 成功）
    '---',
    '',
    '## s1: 章--見出し', // C7: scene.title は不変（見出し）
    '',
    '[背景: a--b.png]', // C5: Background.path は不変（アセットパス）
    '',
    '**カコ--A**:', // C6: Dialog.character は不変（話者名）
    'そう……', // C2: … 連続の個数保持（そう…… → そう⋯⋯）
    'A---B', // C3: 3連ハイフンは本文でも不変（markdown hr 誤置換ガード）
    '',
    '---', // C4: 単独 --- は PageBreak（───化 / Dialog化しない）
    '',
    '次。',
    '',
  ].join('\n')

  const collectEvents = (doc: Awaited<ReturnType<typeof parseMarkdown>>) =>
    doc.chapters.flatMap((c) => c.scenes.flatMap((s) => s.events))

  it('C2: `…` の個数を保持して正準化する（そう…… → そう⋯⋯）', async () => {
    // 先頭 Dialog（カコ--A）の 1 行目。… 2 連 → ⋯ 2 連（個数保持）。
    const events = collectEvents(await parseMarkdown(markdown))
    const dialog = events.find((e) => typeof e === 'object' && 'Dialog' in e)
    expect(dialog && 'Dialog' in dialog && dialog.Dialog.text[0]).toBe('そう⋯⋯')
  })

  it('C3: 本文中の 3 連ハイフン `A---B` は不変（markdown hr 誤置換ガード）', async () => {
    const events = collectEvents(await parseMarkdown(markdown))
    const dialog = events.find((e) => typeof e === 'object' && 'Dialog' in e)
    // 2 行目は 3 連なので ── 化されずそのまま。
    expect(dialog && 'Dialog' in dialog && dialog.Dialog.text[1]).toBe('A---B')
  })

  it('C4: 単独 `---` 行は PageBreak として存在し、───化 / Dialog化しない', async () => {
    const events = collectEvents(await parseMarkdown(markdown))
    // 単独 --- は一級の PageBreak（JS 上は文字列 "PageBreak"）。
    expect(events).toContain('PageBreak')
    // 本文テキスト行に「───（誤正準化）」も「---（Dialog化）」も現れない。
    // （A---B は '───' とも '---' 単独とも一致しないので偽陽性にならない）。
    const bodyLines = events.flatMap((e) => {
      if (typeof e === 'object' && 'Dialog' in e) return e.Dialog.text
      if (typeof e === 'object' && 'Narration' in e) return e.Narration.text
      return []
    })
    expect(bodyLines).not.toContain('───')
    expect(bodyLines).not.toContain('---')
  })

  it('C5: `[背景: a--b.png]` のアセットパスは不変（a--b.png）', async () => {
    const events = collectEvents(await parseMarkdown(markdown))
    const bg = events.find((e) => typeof e === 'object' && 'Background' in e)
    expect(bg && 'Background' in bg && bg.Background.path).toBe('a--b.png')
  })

  it('C6: 話者名 `カコ--A` は不変（Dialog.character）', async () => {
    const events = collectEvents(await parseMarkdown(markdown))
    const dialog = events.find((e) => typeof e === 'object' && 'Dialog' in e)
    expect(dialog && 'Dialog' in dialog && dialog.Dialog.character).toBe('カコ--A')
  })

  it('C7: 見出しタイトル `章--見出し` は不変（scene.title）', async () => {
    const doc = await parseMarkdown(markdown)
    expect(doc.chapters[0].scenes[0].title).toBe('章--見出し')
  })

  it('C8: frontmatter の chapter.title `a--b` は不変（フェンス破綻せず parse 成功）', async () => {
    const doc = await parseMarkdown(markdown)
    expect(doc.chapters[0].title).toBe('a--b')
  })
})

describe('parseMarkdown RpgEvent 内会話の正準化スコープ end-to-end (#340 / S1)', () => {
  // 実 parse（Rust wasm）→ normalizeEvents（JS 二段目）で、`[イベント]`（RpgEvent）内の会話
  // （EventCommand::Dialog/Narration の text）が正準化され、話者名・`[NPC]` の message・NPC 名は
  // 不変であることを end-to-end で固定する。
  const markdown = [
    '---',
    'engine: name-name',
    'chapter: 1',
    'title: t',
    '---',
    '',
    '## m: マップ',
    '',
    '[NPC 村人 @1,1 色=#ffcc00]',
    'また--きて…', // 対象外: NpcData.message は不変
    '[/NPC]',
    '',
    '[イベント talk]',
    '**司会--A**:', // 対象外: 話者名は不変
    '待って--行かないで…', // 対象: RpgEvent Dialog.text → 待って──行かないで⋯
    '> 風が--吹いた…', // 対象: RpgEvent Narration.text → 風が──吹いた⋯
    '[/イベント]',
    '',
  ].join('\n')

  const collectEvents = (doc: Awaited<ReturnType<typeof parseMarkdown>>) =>
    doc.chapters.flatMap((c) => c.scenes.flatMap((s) => s.events))

  it('RpgEvent 内の Dialog/Narration の text は正準化・話者名は不変', async () => {
    const events = collectEvents(await parseMarkdown(markdown))
    const rpg = events.find((e) => typeof e === 'object' && 'RpgEvent' in e)
    if (!rpg || typeof rpg !== 'object' || !('RpgEvent' in rpg)) {
      throw new Error('RpgEvent not found')
    }
    const commands = rpg.RpgEvent.commands
    const dialog = commands.find((c) => c.type === 'Dialog')
    const narration = commands.find((c) => c.type === 'Narration')
    expect(dialog?.type === 'Dialog' && dialog.text).toEqual(['待って──行かないで⋯'])
    expect(dialog?.type === 'Dialog' && dialog.character).toBe('司会--A') // 話者名は不変
    expect(narration?.type === 'Narration' && narration.text).toEqual(['風が──吹いた⋯'])
  })

  it('対象外: `[NPC]` の message と NPC 名は不変', async () => {
    const events = collectEvents(await parseMarkdown(markdown))
    const npc = events.find((e) => typeof e === 'object' && 'Npc' in e)
    expect(npc && 'Npc' in npc && npc.Npc.message).toEqual(['また--きて…'])
    expect(npc && 'Npc' in npc && npc.Npc.name).toBe('村人')
  })
})
