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

import { describe, expect, it, vi } from 'vitest'
import { parseMarkdown, emitMarkdown } from './parser'

describe('parseMarkdown + normalizeDocument: per-game frontmatter fields survive normalize (#310)', () => {
  // #308 / #310 / #407 / 既存 (#283 dialog_style / #286 protagonist) をまとめて持つ最小スクリプト。
  // 各値はあえて「既定と異なる値」にして、normalize が黙って既定へ倒す退行も捕まえる。
  // character_y_ratio=1.05（既定 1.0 と異なる）/ character_fade_ms=500（#407 で既定が 300→700 に
  // 変わったので、既定 700 と異なる 500 に更新）/ background_fade_ms=2000（既定 700 と異なる・#407）/
  // skip_enabled=false（既定 true と異なる）/ debug_enabled=true（既定 false と異なる）を明示し、
  // normalize が値を保持することを見る。
  const markdown = [
    '---',
    'engine: name-name',
    'chapter: 1',
    'title: t',
    'character_y_ratio: 1.05',
    'character_fade_ms: 500',
    'background_fade_ms: 2000',
    'event_image_fade_ms: 1400',
    'skip_enabled: false',
    'debug_enabled: true',
    'dialog_style: novel',
    'protagonist: せお',
    '---',
    '',
    '## s:',
    '',
    '**A**:',
    'x',
    '',
  ].join('\n')

  it('keeps character_y_ratio / character_fade_ms / background_fade_ms / event_image_fade_ms / skip_enabled / debug_enabled from frontmatter', async () => {
    const doc = await parseMarkdown(markdown)
    // ここが core: #308 / #310 / #407 のフィールドが normalize を生き残ること。
    // normalizeDocument の return から該当行を消すと undefined になり落ちる（修正前の状態）。
    expect(doc.character_y_ratio).toBe(1.05)
    expect(doc.character_fade_ms).toBe(500)
    expect(doc.background_fade_ms).toBe(2000)
    expect(doc.event_image_fade_ms).toBe(1400)
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
    expect(doc.background_fade_ms).toBeNull()
    expect(doc.event_image_fade_ms).toBeNull()
    expect(doc.skip_enabled).toBeNull()
    expect(doc.debug_enabled).toBeNull()
  })
})

describe('parseMarkdown + normalizeDocument: character exit fade survives normalize', () => {
  const markdown = [
    '---',
    'engine: name-name',
    'chapter: 1',
    'title: t',
    '---',
    '',
    '## s:',
    '',
    '[退場: ヴィンチア, fade=2100]',
    '',
  ].join('\n')

  it('keeps per-exit fade_ms from [退場: name, フェード=N]', async () => {
    const doc = await parseMarkdown(markdown)
    expect(doc.chapters[0].scenes[0].events[0]).toEqual({
      Exit: { character: 'ヴィンチア', fade_ms: 2100 },
    })
  })

  it('emits per-exit fade_ms in normalized Japanese key order', async () => {
    const doc = await parseMarkdown(markdown)
    const emitted = await emitMarkdown(doc)
    expect(emitted).toContain('[退場: ヴィンチア, フェード=2100]')
  })
})

describe('parseMarkdown + normalizeDocument: EventImage effects が normalize を生き残る (#582)', () => {
  // #351 EventImage の back/fade_ms 同様、#582 で追加された effects (ゆらぎ/ビネット/グロー/
  // ろうそく) も normalizeEvents の EventImage 分岐を書き忘れると WASM が parse した値が
  // 黙って落ちる（#310/#378 と同じ事故パターン、#440 の教訓）。pixel_art/split_layout と同じ
  // 流儀で、実 parseMarkdown（WASM_BASE64 同梱・fetch 不要）を通し、event 単位の effects が
  // normalize を生き残ることを縛る。この種のテストが本ブランチに1件もなかった
  // （#378型事故を明示的に防ぐ場所はここ）。
  it('[イベント絵: path, ゆらぎ=true, ビネット=true, グロー=true, ろうそく=true] の全フラグが doc.effects に反映される', async () => {
    const markdown = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s:',
      '',
      '[イベント絵: story/x.webp, ゆらぎ=true, ビネット=true, グロー=true, ろうそく=true]',
      '',
    ].join('\n')
    const doc = await parseMarkdown(markdown)
    expect(doc.chapters[0].scenes[0].events[0]).toEqual({
      EventImage: {
        path: 'story/x.webp',
        back: 'Hide',
        fade_ms: null,
        effects: { wobble: true, vignette: true, glow: true, candle: true },
      },
    })
  })

  it('演出kv省略時、effects は全 false 相当に正規化される', async () => {
    const markdown = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s:',
      '',
      '[イベント絵: story/x.webp]',
      '',
    ].join('\n')
    const doc = await parseMarkdown(markdown)
    expect(doc.chapters[0].scenes[0].events[0]).toEqual({
      EventImage: {
        path: 'story/x.webp',
        back: 'Hide',
        fade_ms: null,
        effects: { wobble: false, vignette: false, glow: false, candle: false },
      },
    })
  })
})

describe('parseMarkdown + normalizeDocument: speaker_nudge が normalize を生き残る (#382)', () => {
  // #378 の「wasm がキーを黙って捨てる」回帰防止線。normalizeDocument の列挙に speaker_nudge を
  // 書き忘れると WASM が parse した値が /play runtime（NovelRenderer.setSpeakerNudge）に届かず、
  // false（nudge 抑制）が効かなくなる。実 parseMarkdown を通し、値が normalize を生き残ることを縛る。
  function docWith(nudgeLine: string): string {
    return [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      'dialog_style: novel',
      nudgeLine,
      '---',
      '',
      '## s',
      '',
      '**A**:',
      'x',
      '',
    ].join('\n')
  }

  it('C1: speaker_nudge: false → doc.speaker_nudge === false（値が normalize を生き残る・#378）', async () => {
    const doc = await parseMarkdown(docWith('speaker_nudge: false'))
    expect(doc.speaker_nudge).toBe(false)
  })

  it('C2: speaker_nudge: true → doc.speaker_nudge === true', async () => {
    const doc = await parseMarkdown(docWith('speaker_nudge: true'))
    expect(doc.speaker_nudge).toBe(true)
  })

  it('C3: speaker_nudge 省略 → doc.speaker_nudge === null（未指定は下流で既定 false＝非発火・opt-in）', async () => {
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
    expect(doc.speaker_nudge).toBeNull()
  })
})

describe('parseMarkdown + normalizeDocument: auto_play が normalize を生き残る (#436)', () => {
  // wasm がキーを黙って捨てる罠の回帰防止線。normalizeDocument の列挙に auto_play を書き忘れると
  // WASM が parse した値が /play runtime（NovelPlayer の初期 autoMode）に届かず、既定 OFF に
  // 上書きできなくなる。実 parseMarkdown を通し、値が normalize を生き残ることを縛る。
  function docWith(autoLine: string): string {
    return [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      'dialog_style: novel',
      autoLine,
      '---',
      '',
      '## s',
      '',
      '**A**:',
      'x',
      '',
    ].join('\n')
  }

  it('E1: auto_play: true → doc.auto_play === true', async () => {
    const doc = await parseMarkdown(docWith('auto_play: true'))
    expect(doc.auto_play).toBe(true)
  })

  it('E2: auto_play: false → doc.auto_play === false（値が normalize を生き残る）', async () => {
    const doc = await parseMarkdown(docWith('auto_play: false'))
    expect(doc.auto_play).toBe(false)
  })

  it('E3: auto_play 省略 → doc.auto_play === null（未指定は下流で既定 false＝手送り）', async () => {
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
    expect(doc.auto_play).toBeNull()
  })
})

describe('parseMarkdown + normalizeDocument: seekbar_color が normalize を生き残る (#440)', () => {
  // session752 の教訓（cargo test だけでは本番の古い wasm が新 frontmatter キーを黙って落とす）に倣い、
  // 実 parseMarkdown（WASM_BASE64 同梱）を通して seekbar_color が Rust parse → JS normalize を
  // 生き残ることを縛る。normalizeDocument の列挙に seekbar_color を書き忘れると /play runtime
  // （NovelRenderer.setSeekBarColor）に届かず、金色スライダが既定の水色に戻る回帰になる。
  function docWith(seekbarLine: string): string {
    return [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      'dialog_style: novel',
      seekbarLine,
      '---',
      '',
      '## s',
      '',
      '**A**:',
      'x',
      '',
    ].join('\n')
  }

  it('F1: seekbar_color: "#b8934f" → doc.seekbar_color === "#b8934f"（値が normalize を生き残る）', async () => {
    const doc = await parseMarkdown(docWith('seekbar_color: "#b8934f"'))
    expect(doc.seekbar_color).toBe('#b8934f')
  })

  it('F2: seekbar_color 省略 → doc.seekbar_color === null（未指定は下流で既定の水色 #a8dadc）', async () => {
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
    expect(doc.seekbar_color).toBeNull()
  })
})

describe('parseMarkdown + normalizeDocument: split_layout が normalize を生き残る (#442)', () => {
  // このリポで繰り返し起きている事故パターン（#310/#378/#436/#440＝新しい frontmatter フィールドが
  // Rust parser か normalizeDocument のどちらかで黙って消える）の frontend 側生存確認。
  // normalizeDocument の列挙に split_layout を書き忘れると WASM が parse した値が /play runtime
  // （NovelRenderer.setSplitLayout）に届かず、Gymnasia 向けの画像/テキスト分割配置が効かなくなる。
  // 実 parseMarkdown（WASM_BASE64 同梱・fetch 不要）を通し、値が normalize を生き残ることを縛る。
  function docWith(splitLayoutLine: string): string {
    return [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      'dialog_style: novel',
      splitLayoutLine,
      '---',
      '',
      '## s',
      '',
      '**A**:',
      'x',
      '',
    ].join('\n')
  }

  it('G1: split_layout: true → doc.split_layout === true', async () => {
    const doc = await parseMarkdown(docWith('split_layout: true'))
    expect(doc.split_layout).toBe(true)
  })

  it('G2: split_layout: false → doc.split_layout === false（値が normalize を生き残る・false が null に潰れない）', async () => {
    const doc = await parseMarkdown(docWith('split_layout: false'))
    expect(doc.split_layout).toBe(false)
  })

  it('G3: split_layout 省略 → doc.split_layout === null（未指定は下流で既定 false＝従来の全面+オーバーレイ）', async () => {
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
    expect(doc.split_layout).toBeNull()
  })
})

describe('parseMarkdown + normalizeDocument: sentence_per_page が normalize を生き残る (#448)', () => {
  // このリポで繰り返し起きている事故パターン（#310/#378/#436/#440/#442＝新しい frontmatter フィールドが
  // Rust parser か normalizeDocument のどちらかで黙って消える）の frontend 側生存確認。
  // normalizeDocument の列挙に sentence_per_page を書き忘れると WASM が parse した値が /play runtime
  // （NovelRenderer.setSentencePerPage）に届かず、文単位の厳密改頁が効かなくなる。
  // 実 parseMarkdown（WASM_BASE64 同梱・fetch 不要）を通し、値が normalize を生き残ることを縛る。
  function docWith(sentencePerPageLine: string): string {
    return [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      'dialog_style: novel',
      sentencePerPageLine,
      '---',
      '',
      '## s',
      '',
      '**A**:',
      'x',
      '',
    ].join('\n')
  }

  it('J1: sentence_per_page: true → doc.sentence_per_page === true', async () => {
    const doc = await parseMarkdown(docWith('sentence_per_page: true'))
    expect(doc.sentence_per_page).toBe(true)
  })

  it('J2: sentence_per_page: false → doc.sentence_per_page === false（値が normalize を生き残る・false が null に潰れない）', async () => {
    const doc = await parseMarkdown(docWith('sentence_per_page: false'))
    expect(doc.sentence_per_page).toBe(false)
  })

  it('J3: sentence_per_page 省略 → doc.sentence_per_page === null（未指定は下流で既定 false＝従来どおり）', async () => {
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
    expect(doc.sentence_per_page).toBeNull()
  })
})

describe('parseMarkdown + normalizeDocument: pixel_art が normalize を生き残る (#466)', () => {
  // このリポで繰り返し起きている事故パターン（#310/#378/#436/#440/#442＝新しい frontmatter フィールドが
  // Rust parser か normalizeDocument のどちらかで黙って消える）の frontend 側生存確認。
  // normalizeDocument の列挙に pixel_art を書き忘れると WASM が parse した値が /play runtime
  // （NovelRenderer.setPixelArt）に届かず、nearest-neighbor スケールが効かなくなる。
  // 実 parseMarkdown（WASM_BASE64 同梱・fetch 不要）を通し、値が normalize を生き残ることを縛る。
  function docWith(pixelArtLine: string): string {
    return [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      pixelArtLine,
      '---',
      '',
      '## s',
      '',
      '**A**:',
      'x',
      '',
    ].join('\n')
  }

  it('W1: pixel_art: true → doc.pixel_art === true', async () => {
    const doc = await parseMarkdown(docWith('pixel_art: true'))
    expect(doc.pixel_art).toBe(true)
  })

  it('W2: pixel_art: false → doc.pixel_art === false（値が normalize を生き残る・false が null に潰れない）', async () => {
    const doc = await parseMarkdown(docWith('pixel_art: false'))
    expect(doc.pixel_art).toBe(false)
  })

  it('W3: pixel_art 省略 → doc.pixel_art === null（未指定は下流で既定 false＝従来どおり linear）', async () => {
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
    expect(doc.pixel_art).toBeNull()
  })
})

describe('parseMarkdown + normalizeDocument: fullscreen_image が normalize を生き残る (#530/#547)', () => {
  // このリポで繰り返し起きている事故パターン（#310/#378/#436/#440/#442/#466＝新しい frontmatter
  // フィールドが Rust parser か normalizeDocument のどちらかで黙って消える）の frontend 側生存確認。
  // normalizeDocument の列挙に fullscreen_image を書き忘れると WASM が parse した値が /play runtime
  // （NovelRenderer.setFullscreenImageMode）に届かず、フルキャンバス画像表示モードが効かなくなる。
  // #547 must2: #530 の初回実装時にこのクラスのテストが一本も追加されておらず、独立レビューで
  // 規約逸脱として指摘された。実 parseMarkdown（WASM_BASE64 同梱・fetch 不要）を通し、値が
  // normalize を生き残ることを縛る。
  function docWith(fullscreenImageLine: string): string {
    return [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      fullscreenImageLine,
      '---',
      '',
      '## s',
      '',
      '**A**:',
      'x',
      '',
    ].join('\n')
  }

  it('FI1: fullscreen_image: true → doc.fullscreen_image === true', async () => {
    const doc = await parseMarkdown(docWith('fullscreen_image: true'))
    expect(doc.fullscreen_image).toBe(true)
  })

  it('FI2: fullscreen_image: false → doc.fullscreen_image === false（値が normalize を生き残る・false が null に潰れない）', async () => {
    const doc = await parseMarkdown(docWith('fullscreen_image: false'))
    expect(doc.fullscreen_image).toBe(false)
  })

  it('FI3: fullscreen_image 省略 → doc.fullscreen_image === null（未指定は下流で既定 false＝従来どおり）', async () => {
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
    expect(doc.fullscreen_image).toBeNull()
  })
})

describe('parseMarkdown + normalizeDocument: header が normalize を生き残る (#519)', () => {
  // このリポで繰り返し起きている事故パターン（#310/#378/#436/#440/#442/#466＝新しい frontmatter
  // フィールドが Rust parser か normalizeDocument のどちらかで黙って消える）の frontend 側生存確認。
  // normalizeDocument の列挙に header を書き忘れると WASM が parse した値が
  // PlayerScreen.normalizeHeaderMode に届かず、standalone ヘッダ抑制（hidden/collapsed）が
  // 効かなくなる。実 parseMarkdown（WASM_BASE64 同梱・fetch 不要）を通し、Rust parse →
  // JS normalize（nullIfEmpty）を生き残ることを、モック越しでなく縛る。
  function docWith(headerLine: string): string {
    return [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      headerLine,
      '---',
      '',
      '## s',
      '',
      '**A**:',
      'x',
      '',
    ].join('\n')
  }

  it('V1: header: collapsed → doc.header === "collapsed"（値が normalize を生き残る）', async () => {
    const doc = await parseMarkdown(docWith('header: collapsed'))
    expect(doc.header).toBe('collapsed')
  })

  it('V2: header: hidden → doc.header === "hidden"', async () => {
    const doc = await parseMarkdown(docWith('header: hidden'))
    expect(doc.header).toBe('hidden')
  })

  it('V3: header 省略 → doc.header === null（未指定は runtime 既定 visible にフォールバック）', async () => {
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
    expect(doc.header).toBeNull()
  })
})

describe('parseMarkdown: aspect_ratio: auto が実 parse を通して保持される (#442)', () => {
  // fluid モード（NovelPlayer の pickFluidAspectRatio 分岐）の判定元。既存 3 値（16:9/4:3/9:16）と
  // 対等に、Rust parser → normalizeDocument（`aspect_ratio: doc.aspect_ratio` は素通し）を通しても
  // "auto" の文字列がそのまま保持されることを確認する。
  it('H1: aspect_ratio: auto → doc.aspect_ratio === "auto"', async () => {
    const markdown = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      'aspect_ratio: auto',
      '---',
      '',
      '## s',
      '',
      '**A**:',
      'x',
      '',
    ].join('\n')
    const doc = await parseMarkdown(markdown)
    expect(doc.aspect_ratio).toBe('auto')
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

// #508: [選択: 列=N] のグリッド列数が normalizeEvents（frontend/src/wasm/parser.ts の
// フィールド列挙リビルド）を生き残ることを実 parse 経路で縛る。normalizeEvents の Choice
// ブランチは options を都度作り直すため、新フィールドを列挙に足し忘れると WASM が返した値が
// 黙って落ちる（#308/#310/#407 と同種の罠）。setter 直呼びは検知できない偽陰性になるため
// 必ず parseMarkdown() を通す。
describe('parseMarkdown + normalizeEvents: Choice.columns が normalize を生き残る (#508)', () => {
  const findChoice = (doc: Awaited<ReturnType<typeof parseMarkdown>>) =>
    doc.chapters
      .flatMap((c) => c.scenes.flatMap((s) => s.events))
      .find((e) => typeof e === 'object' && 'Choice' in e) as
      | { Choice: { options: { text: string; jump: string }[]; columns?: number | null } }
      | undefined

  it('[選択: 列=5] → doc の Choice.columns === 5', async () => {
    const markdown = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s1: シーン',
      '',
      '[選択: 列=5]',
      '- A → a',
      '- B → b',
      '[/選択]',
      '',
    ].join('\n')

    const choice = findChoice(await parseMarkdown(markdown))
    expect(choice?.Choice.columns).toBe(5)
    expect(choice?.Choice.options.map((o) => o.text)).toEqual(['A', 'B'])
  })

  it('[選択]（列数指定なし）→ doc の Choice.columns === null（従来どおりの縦一列、非破壊）', async () => {
    const markdown = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s1: シーン',
      '',
      '[選択]',
      '- A → a',
      '- B → b',
      '[/選択]',
      '',
    ].join('\n')

    const choice = findChoice(await parseMarkdown(markdown))
    expect(choice?.Choice.columns).toBeNull()
  })

  it('[選択: 列=0] のような不正値は columns が null になる（parser 側で 1 未満を弾く）', async () => {
    const markdown = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s1: シーン',
      '',
      '[選択: 列=0]',
      '- A → a',
      '- B → b',
      '[/選択]',
      '',
    ].join('\n')

    const choice = findChoice(await parseMarkdown(markdown))
    expect(choice?.Choice.columns).toBeNull()
  })
})

// #508 テスト観点整理フェーズで「要追加」と判定された異常系・境界値・round-trip の穴埋め。
// TS 側（parseMarkdown 経由）の観点。Rust 側の parse_choice_columns 自体は
// parser/tests/integration_test.rs（test_choice_grid_columns）で既にカバー済みなので、
// ここでは wasm 境界を越えて normalizeEvents まで通した後の値・console 汚染・round-trip を見る。
describe('parseMarkdown: [選択: 列=N] の異常値・記法ゆらぎ (#508 テスト観点整理フェーズ追加分)', () => {
  function markdownWithChoiceTag(tag: string): string {
    return [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s1: シーン',
      '',
      tag,
      '- A → a',
      '- B → b',
      '[/選択]',
      '',
    ].join('\n')
  }

  const findChoice = (doc: Awaited<ReturnType<typeof parseMarkdown>>) =>
    doc.chapters
      .flatMap((c) => c.scenes.flatMap((s) => s.events))
      .find((e) => typeof e === 'object' && 'Choice' in e) as
      | { Choice: { options: { text: string; jump: string }[]; columns?: number | null } }
      | undefined

  it('列=-1（負数）は columns=null になる', async () => {
    const doc = await parseMarkdown(markdownWithChoiceTag('[選択: 列=-1]'))
    expect(findChoice(doc)?.Choice.columns).toBeNull()
  })

  it('列=abc（非数値）は columns=null になる', async () => {
    const doc = await parseMarkdown(markdownWithChoiceTag('[選択: 列=abc]'))
    expect(findChoice(doc)?.Choice.columns).toBeNull()
  })

  it('列=（値無し）は columns=null になる', async () => {
    const doc = await parseMarkdown(markdownWithChoiceTag('[選択: 列=]'))
    expect(findChoice(doc)?.Choice.columns).toBeNull()
  })

  it('[選択: 列=5,]（末尾カンマの記法ゆらぎ）は影響なく columns=5 として解釈される', async () => {
    const doc = await parseMarkdown(markdownWithChoiceTag('[選択: 列=5,]'))
    expect(findChoice(doc)?.Choice.columns).toBe(5)
    // 末尾カンマがオプション自体の parse を壊していないことも併せて確認
    expect(findChoice(doc)?.Choice.options.map((o) => o.text)).toEqual(['A', 'B'])
  })

  it('不正な列=値（負数/非数値/0）を含む .md を parse してもconsole.warn/errorを出さない（spec通り警告なしでフォールバック）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await parseMarkdown(markdownWithChoiceTag('[選択: 列=-1]'))
    await parseMarkdown(markdownWithChoiceTag('[選択: 列=abc]'))
    await parseMarkdown(markdownWithChoiceTag('[選択: 列=0]'))
    await parseMarkdown(markdownWithChoiceTag('[選択: 列=]'))

    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

// TS 側の round-trip（parse → emit → parse）で columns が保持されることの確認。
// Rust 側の parser::parse → emitter::emit → parser::parse は
// parser/tests/integration_test.rs（test_choice_grid_columns）で既にカバー済みだが、
// そちらは Rust の Event 構造体を直接比較するのみで、TS 側の normalizeEvents（wasm 境界の
// フィールド列挙リビルド）を経由した emitMarkdown/parseMarkdown の往復は未カバーだった。
describe('parseMarkdown + emitMarkdown: Choice.columns の round-trip (#508)', () => {
  const findChoice = (doc: Awaited<ReturnType<typeof parseMarkdown>>) =>
    doc.chapters
      .flatMap((c) => c.scenes.flatMap((s) => s.events))
      .find((e) => typeof e === 'object' && 'Choice' in e) as
      | { Choice: { options: { text: string; jump: string }[]; columns?: number | null } }
      | undefined

  it('parse → emit → parse を経ても列数が保持される', async () => {
    const markdown = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s1: シーン',
      '',
      '[選択: 列=5]',
      '- A → a',
      '- B → b',
      '- C → c',
      '[/選択]',
      '',
    ].join('\n')

    const doc1 = await parseMarkdown(markdown)
    expect(findChoice(doc1)?.Choice.columns).toBe(5)

    const emitted = await emitMarkdown(doc1)
    expect(emitted).toContain('[選択: 列=5]')

    const doc2 = await parseMarkdown(emitted)
    expect(findChoice(doc2)?.Choice.columns).toBe(5)
  })

  it('列数指定なしの [選択] も round-trip で columns=null のまま保持される（非破壊の再確認）', async () => {
    const markdown = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s1: シーン',
      '',
      '[選択]',
      '- A → a',
      '- B → b',
      '[/選択]',
      '',
    ].join('\n')

    const doc1 = await parseMarkdown(markdown)
    expect(findChoice(doc1)?.Choice.columns).toBeNull()

    const emitted = await emitMarkdown(doc1)
    expect(emitted).not.toContain('列=')

    const doc2 = await parseMarkdown(emitted)
    expect(findChoice(doc2)?.Choice.columns).toBeNull()
  })
})

describe('parseMarkdown: WaitDisplayComplete (#411)', () => {
  const collectEvents = (markdown: string) =>
    parseMarkdown(markdown).then((doc) =>
      doc.chapters.flatMap((c) => c.scenes.flatMap((s) => s.events))
    )

  function markdownWithWait(line: string): string {
    return [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## 1-1: シーン',
      '',
      '[背景: bg.png]',
      line,
      '',
      '**A**:',
      'after',
      '',
    ].join('\n')
  }

  it('[待機: 表示完了] は WASM 実 parse 経路で WaitDisplayComplete として届く', async () => {
    const events = await collectEvents(markdownWithWait('[待機: 表示完了]'))
    expect(events).toContain('WaitDisplayComplete')
    expect(events).not.toContain('SceneTransition')
  })

  it('[待機: 700] は既存互換の Wait(ms) として届く', async () => {
    const events = await collectEvents(markdownWithWait('[待機: 700]'))
    expect(events).toContainEqual({ Wait: { ms: 700 } })
    expect(events).not.toContain('WaitDisplayComplete')
  })

  it('[待機: 表示完了 ] / [待機:表示完了] も WaitDisplayComplete として受理する', async () => {
    await expect(collectEvents(markdownWithWait('[待機: 表示完了 ]'))).resolves.toContain(
      'WaitDisplayComplete'
    )
    await expect(collectEvents(markdownWithWait('[待機:表示完了]'))).resolves.toContain(
      'WaitDisplayComplete'
    )
  })

  it('[待機:] / [待機: ] は Wait 系イベント化されない', async () => {
    const empty = await collectEvents(markdownWithWait('[待機:]'))
    const blank = await collectEvents(markdownWithWait('[待機: ]'))

    for (const events of [empty, blank]) {
      expect(events).not.toContain('WaitDisplayComplete')
      expect(events.some((e) => typeof e === 'object' && 'Wait' in e)).toBe(false)
    }
  })
})

// #364 / #360 穴埋め: character_height_ratio(s) は wasm 境界で Rust の HashMap<String, f64> が
// tsify 経由で Map になって返るため、normalizeDocument が Object.fromEntries で Record に変換する
// （parser.ts の character_height_ratios コメント参照）。この変換自体はこのファイルに一件も
// テストが無かった穴なので、#364 の per-character override 分と併せて実 parseMarkdown（WASM 経由）
// で縛る。
describe('parseMarkdown: character_height_ratios の wasm 境界正規化 (#364 / #360 穴埋め)', () => {
  it('T-WASM-01: character_height_ratios: theo:0.65,hue:0.68 は doc.character_height_ratios が {theo:0.65, hue:0.68} になる', async () => {
    const markdown = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      'character_height_ratios: theo:0.65,hue:0.68',
      '---',
      '',
      '## s',
      '',
      '**A**:',
      'x',
      '',
    ].join('\n')
    const doc = await parseMarkdown(markdown)
    expect(doc.character_height_ratios).toEqual({ theo: 0.65, hue: 0.68 })
  })

  it('T-WASM-02: 未指定なら doc.character_height_ratios は空オブジェクト {}（null/undefined ではないことが型契約上重要）', async () => {
    const markdown = [
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
    const doc = await parseMarkdown(markdown)
    expect(doc.character_height_ratios).toEqual({})
    expect(doc.character_height_ratios).not.toBeNull()
    expect(doc.character_height_ratios).not.toBeUndefined()
  })

  it('T-WASM-03: character_height_ratio（単数形・#360）も character_height_ratios（複数形・#364）と同時に正しく parse される（#360 の穴埋め）', async () => {
    const markdown = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      'character_height_ratio: 0.8',
      'character_height_ratios: theo:0.65',
      '---',
      '',
      '## s',
      '',
      '**A**:',
      'x',
      '',
    ].join('\n')
    const doc = await parseMarkdown(markdown)
    expect(doc.character_height_ratio).toBe(0.8)
    expect(doc.character_height_ratios).toEqual({ theo: 0.65 })
  })
})

// このファイルに emitMarkdown 呼び出しテストが一件も無かったので新設する（#364）。
describe('emitMarkdown: character_height_ratios の emit (#364)', () => {
  const minimalMarkdown = [
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

  it('T-WASM-04: character_height_ratios を含む EventDocument から正しくソートされた frontmatter 行を emit する', async () => {
    const doc = await parseMarkdown(minimalMarkdown)
    const withRatios = { ...doc, character_height_ratios: { theo: 0.65, hue: 0.68 } }
    const emitted = await emitMarkdown(withRatios)
    expect(emitted).toContain('character_height_ratios: hue:0.68,theo:0.65')
  })

  it('T-WASM-05: character_height_ratios キー自体を持たない legacy 形状の document を渡してもクラッシュしない', async () => {
    const doc = await parseMarkdown(minimalMarkdown)
    const legacy = { ...doc } as Record<string, unknown>
    delete legacy.character_height_ratios
    const emitted = await emitMarkdown(legacy as never)
    expect(typeof emitted).toBe('string')
    // 未指定（フィールド欠落）は空マップ扱いと同じく行を出さない。
    expect(emitted).not.toContain('character_height_ratios')
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
    '[NPC 村人--A @1,1 色=#ffcc00]',
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
    // NPC 名も対象外＝`--` を含んでも正準化されず不変（Rust 側と対称）。
    expect(npc && 'Npc' in npc && npc.Npc.name).toBe('村人--A')
  })
})

describe('parseMarkdown + normalizeEvents: RpgMap の encounter_rate/encounter_groups が normalize を生き残る (#517)', () => {
  // #172 で追加された encounter_rate/encounter_groups が normalizeEvents の RpgMap ブランチの
  // フィールド列挙リビルドから漏れ、常に undefined に潰れていた回帰テスト（#308/#310/#407/#508 に
  // 続く同型バグの5件目）。RpgMap ブランチを spread 方式に倒した修正が正しく効いていることを、
  // 実 parseMarkdown（WASM 同梱）経由で確認する。
  const markdownWithEncounter = [
    '---',
    'engine: name-name',
    'chapter: 1',
    'title: t',
    '---',
    '',
    '## m: マップ',
    '',
    '[マップ 3x3 タイル=32]',
    'GGG',
    'GGG',
    'GGG',
    '[/マップ]',
    '[エンカウント率: 1/16]',
    '[エンカウント群: slime, ghost]',
    '',
  ].join('\n')

  const markdownWithoutEncounter = [
    '---',
    'engine: name-name',
    'chapter: 1',
    'title: t',
    '---',
    '',
    '## m: マップ',
    '',
    '[マップ 3x3 タイル=32]',
    'GGG',
    'GGG',
    'GGG',
    '[/マップ]',
    '',
  ].join('\n')

  const findRpgMap = (doc: Awaited<ReturnType<typeof parseMarkdown>>) => {
    const events = doc.chapters.flatMap((c) => c.scenes.flatMap((s) => s.events))
    const rpgMap = events.find((e) => typeof e === 'object' && 'RpgMap' in e)
    if (!rpgMap || typeof rpgMap !== 'object' || !('RpgMap' in rpgMap)) {
      throw new Error('RpgMap not found')
    }
    return rpgMap.RpgMap
  }

  it('encounter_rate/encounter_groups が normalize 後も保持される', async () => {
    const map = findRpgMap(await parseMarkdown(markdownWithEncounter))
    expect(map.encounter_rate).toBe(16)
    expect(map.encounter_groups).toEqual(['slime', 'ghost'])
  })

  it('同じ RpgMap の既存フィールド（width/height/tiles）も引き続き保持される（spread化の非回帰）', async () => {
    const map = findRpgMap(await parseMarkdown(markdownWithEncounter))
    expect(map.width).toBe(3)
    expect(map.height).toBe(3)
    expect(map.tiles.length).toBe(3)
  })

  it('未指定時は encounter_rate/encounter_groups が null に正規化される（undefined ではない）', async () => {
    const map = findRpgMap(await parseMarkdown(markdownWithoutEncounter))
    expect(map.encounter_rate).toBeNull()
    expect(map.encounter_groups).toBeNull()
  })
})

describe('parseMarkdown + normalizeEvents: RpgMap encounter デシジョンテーブル未カバー行 (#517 P1/P3/P4/P5/P6/P7/P9)', () => {
  // 上の describe（#517 本体）は「両方指定」「両方未指定」の2行しか押さえていない。
  // ここでは spread 化した RpgMap ブランチのデシジョンテーブルで空いていた行
  // （rate のみ0/rateのみ正値/両方非trivialな組み合わせ/日本語ID/既存フィールド回帰/console出力）
  // を実 parseMarkdown（WASM 同梱）経由で埋める。

  const findRpgMap = (doc: Awaited<ReturnType<typeof parseMarkdown>>) => {
    const events = doc.chapters.flatMap((c) => c.scenes.flatMap((s) => s.events))
    const rpgMap = events.find((e) => typeof e === 'object' && 'RpgMap' in e)
    if (!rpgMap || typeof rpgMap !== 'object' || !('RpgMap' in rpgMap)) {
      throw new Error('RpgMap not found')
    }
    return rpgMap.RpgMap
  }

  const mapMarkdown = (extraLines: string[]) =>
    [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## m: マップ',
      '',
      '[マップ 3x3 タイル=32]',
      'GGG',
      'GGG',
      'GGG',
      '[/マップ]',
      ...extraLines,
      '',
    ].join('\n')

  const markdownRateZeroOnly = mapMarkdown(['[エンカウント率: 0]'])
  const markdownRatePositiveOnly = mapMarkdown(['[エンカウント率: 8]'])
  const markdownRateZeroWithGroups = mapMarkdown(['[エンカウント率: 0]', '[エンカウント群: slime]'])
  const markdownJapaneseGroups = mapMarkdown([
    '[エンカウント率: 4]',
    '[エンカウント群: スライム, ghost]',
  ])
  const markdownNoEncounterNoHeights = mapMarkdown([])
  const markdownWithHeights = mapMarkdown([
    '[壁高さ]',
    '1 2 1',
    '1 1 1',
    '1 2 1',
    '[/壁高さ]',
    '[床高さ]',
    '0 0 0',
    '0 0.25 0',
    '0 0 0',
    '[/床高さ]',
    '[天井高さ]',
    '1 1 1',
    '1 2 1',
    '1 1 1',
    '[/天井高さ]',
  ])

  it('P1: encounter_rate: 0のみ設定（groups未設定）時、rateは0のまま保持されnullに潰れない', async () => {
    const map = findRpgMap(await parseMarkdown(markdownRateZeroOnly))
    expect(map.encounter_rate).toBe(0)
    expect(map.encounter_groups).toBeNull()
  })

  it('P4: encounter_rateに正値のみ設定（groups未設定）時、rateは保持されgroupsはnullになる', async () => {
    const map = findRpgMap(await parseMarkdown(markdownRatePositiveOnly))
    expect(map.encounter_rate).toBe(8)
    expect(map.encounter_groups).toBeNull()
  })

  it('P3: encounter_rate:0 と encounter_groups が同時設定時、両方とも入力値のまま保持される（rate=0はgroups存在と両立し欠落しない）', async () => {
    const map = findRpgMap(await parseMarkdown(markdownRateZeroWithGroups))
    expect(map.encounter_rate).toBe(0)
    expect(map.encounter_groups).toEqual(['slime'])
  })

  it('P7: encounter_groupsに日本語monster_idが混在しても文字化けせず保持される', async () => {
    const map = findRpgMap(await parseMarkdown(markdownJapaneseGroups))
    expect(map.encounter_groups).toEqual(['スライム', 'ghost'])
  })

  it('P5: wall_heights/floor_heights/ceiling_heightsが指定時は配列のまま保持される（spread化の非回帰）', async () => {
    const map = findRpgMap(await parseMarkdown(markdownWithHeights))
    expect(map.wall_heights).toEqual([
      [1, 2, 1],
      [1, 1, 1],
      [1, 2, 1],
    ])
    expect(map.floor_heights).toEqual([
      [0, 0, 0],
      [0, 0.25, 0],
      [0, 0, 0],
    ])
    expect(map.ceiling_heights).toEqual([
      [1, 1, 1],
      [1, 2, 1],
      [1, 1, 1],
    ])
  })

  it('P5: wall_heights/floor_heights/ceiling_heights未指定時はnullに正規化される（spread化の非回帰）', async () => {
    const map = findRpgMap(await parseMarkdown(markdownNoEncounterNoHeights))
    expect(map.wall_heights).toBeNull()
    expect(map.floor_heights).toBeNull()
    expect(map.ceiling_heights).toBeNull()
  })

  it('P6: RpgMapの必須フィールド（width/height/tile_size/tiles）がspread後も型・値とも変化しない（tile_sizeを明示チェック）', async () => {
    const map = findRpgMap(await parseMarkdown(markdownWithHeights))
    expect(map.width).toBe(3)
    expect(map.height).toBe(3)
    expect(map.tile_size).toBe(32)
    expect(map.tiles).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ])
  })

  it('P9: 上記いずれの正規なケースでもnormalizeEvents実行中にconsole.warn/errorが出ない', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await parseMarkdown(markdownRateZeroOnly)
    await parseMarkdown(markdownRatePositiveOnly)
    await parseMarkdown(markdownRateZeroWithGroups)
    await parseMarkdown(markdownJapaneseGroups)
    await parseMarkdown(markdownWithHeights)
    await parseMarkdown(markdownNoEncounterNoHeights)

    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
