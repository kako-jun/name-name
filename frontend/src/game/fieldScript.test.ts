import { describe, expect, it, vi } from 'vitest'
import type { EventCommand, EventDocument } from '../types'
import { EventRunner } from './eventRunner'
import {
  FieldConversation,
  checkNpcScripts,
  collectFieldEvents,
  createFieldBattleHost,
  createFieldEmotionHost,
  createFieldNpcMover,
  loadFieldScript,
  resolveNpcCommands,
  supportedCommands,
} from './fieldScript'
import { parseMarkdown } from '../wasm/parser'

const dlg = (character: string | undefined, ...text: string[]): EventCommand => ({
  type: 'Dialog',
  character,
  text,
})

const docOf = (events: Record<string, EventCommand[]>): EventDocument =>
  ({
    chapters: [
      {
        scenes: [
          {
            events: Object.entries(events).map(([name, commands]) => ({
              RpgEvent: { name, commands },
            })),
          },
        ],
      },
    ],
  }) as unknown as EventDocument

/** DialogBox の偽物。show で表示中・hide で非表示。typing は 1 回目の advance で全文にする */
function fakeDialog() {
  let showing = false
  let typing = false
  const shown: Array<[string, string]> = []
  return {
    shown,
    get isShowing() {
      return showing
    },
    show: (name: string, text: string) => {
      showing = true
      typing = true
      shown.push([name, text])
    },
    hide: () => {
      showing = false
    },
    isTyping: () => typing,
    skipTypewriter: () => {
      typing = false
    },
    nextPage: () => false,
  }
}

describe('collectFieldEvents', () => {
  it('全 [イベント] を名前で集める（同名は先勝ち）', () => {
    const doc = docOf({ a: [dlg('A', 'x')], b: [dlg('B', 'y')] })
    const events = collectFieldEvents(doc)
    expect([...events.keys()]).toEqual(['a', 'b'])
    const dup = docOf({ a: [dlg('A', '1')] })
    ;(dup.chapters[0].scenes[0].events as unknown[]).push({
      RpgEvent: { name: 'a', commands: [dlg('A', '2')] },
    })
    expect(collectFieldEvents(dup).get('a')).toEqual([dlg('A', '1')])
  })
})

describe('loadFieldScript', () => {
  it('取得して集める', async () => {
    const events = await loadFieldScript(
      'u.md',
      async () => 'md',
      async () => docOf({ a: [dlg('A', 'x')] })
    )
    expect(events.has('a')).toBe(true)
  })
  it('取得失敗は警告して空（例外にしない）', async () => {
    const warn = vi.fn()
    const events = await loadFieldScript(
      'u.md',
      async () => {
        throw new Error('HTTP 404')
      },
      async () => docOf({}),
      warn
    )
    expect(events.size).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 404'))
  })
  it('パース失敗も警告して空', async () => {
    const warn = vi.fn()
    const events = await loadFieldScript(
      'u.md',
      async () => 'md',
      async () => {
        throw new Error('bad')
      },
      warn
    )
    expect(events.size).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('supportedCommands / resolveNpcCommands', () => {
  const events = new Map<string, EventCommand[]>([
    ['hi', [dlg('A', 'こんにちは'), { type: 'Narration', text: ['n'] }, { type: 'Wait', ms: 10 }]],
    [
      'mixed',
      [{ type: 'NpcMove', npc: 'x', x: 1, y: 2 }, dlg('A', 'ok'), { type: 'Battle', id: 'b1' }],
    ],
    ['onlyMove', [{ type: 'NpcMove', npc: 'x', x: 1, y: 2 }]],
    ['onlyWait', [{ type: 'Wait', ms: 100 }]],
    [
      'moveWait',
      [
        { type: 'NpcMove', npc: 'x', x: 1, y: 2 },
        { type: 'Wait', ms: 100 },
      ],
    ],
  ])
  it('台詞・ナレーション・待機はそのまま通す', () => {
    const warn = vi.fn()
    expect(resolveNpcCommands('hi', events, warn)).toHaveLength(3)
    expect(warn).not.toHaveBeenCalled()
  })
  it('NpcMove / Battle は警告して読み飛ばす', () => {
    const warn = vi.fn()
    const cmds = resolveNpcCommands('mixed', events, warn)
    expect(cmds).toEqual([dlg('A', 'ok')])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toContain('NpcMove')
    expect(warn.mock.calls[1][0]).toContain('Battle')
  })
  it('scene 未指定は undefined で警告なし', () => {
    const warn = vi.fn()
    expect(resolveNpcCommands(undefined, events, warn)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
  it('脚本が無い・イベントが無いのは警告して undefined（固定 line へ）', () => {
    const warn = vi.fn()
    expect(resolveNpcCommands('hi', undefined, warn)).toBeUndefined()
    expect(resolveNpcCommands('nope', events, warn)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
  })
  it('実行できるコマンドが無いイベントも undefined（固定 line へ）', () => {
    const warn = vi.fn()
    expect(resolveNpcCommands('onlyMove', events, warn)).toBeUndefined()
    expect(supportedCommands('e', [], warn)).toBeUndefined()
  })
  it('台詞（Dialog / Narration）が 1 つも無いイベント（Wait だけ・NpcMove+Wait）は固定 line へ', () => {
    const warn = vi.fn()
    expect(resolveNpcCommands('onlyWait', events, warn)).toBeUndefined()
    expect(resolveNpcCommands('moveWait', events, warn)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('実行できる台詞がありません'))
  })
  it('Narration だけでも会話になる', () => {
    const only: EventCommand[] = [{ type: 'Narration', text: ['n'] }]
    expect(supportedCommands('e', only, () => {})).toEqual(only)
  })
})

describe('checkNpcScripts（起動時に 1 回だけ照合）', () => {
  const events = new Map<string, EventCommand[]>([['hi', [dlg('A', 'x')]]])
  it('問題なし・scene なしは警告なし', () => {
    expect(checkNpcScripts([{ where: 'a' }, { where: 'b', scene: 'hi' }], events)).toEqual([])
  })
  it('見つからない scene を警告する（同じ scene は 1 回だけ）', () => {
    const w = checkNpcScripts(
      [
        { where: 'a', scene: 'nope' },
        { where: 'b', scene: 'nope' },
      ],
      events
    )
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('nope')
  })
  it('脚本が空・読めていないときは scene 付き NPC ごとに警告する', () => {
    expect(
      checkNpcScripts(
        [{ where: 'a', scene: 'x' }, { where: 'b', scene: 'y' }, { where: 'c' }],
        undefined
      )
    ).toHaveLength(2)
  })
})

describe('no-op ホスト', () => {
  it('NpcMover は警告して即完了、BattleHost は警告して null', async () => {
    const warn = vi.fn()
    await createFieldNpcMover(warn).moveNpcTo('x', 1, 2, 3)
    expect(await createFieldBattleHost(warn).startBattle('b')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('FieldConversation', () => {
  const make = () => {
    const dialog = fakeDialog()
    const runner = new EventRunner(
      dialog as never,
      createFieldNpcMover(() => {}),
      createFieldBattleHost(() => {})
    )
    const conv = new FieldConversation(dialog, runner)
    return { dialog, runner, conv }
  }
  it('脚本: 複数行の台詞を送り、最後を送り終えたら閉じて onEnd', () => {
    const { dialog, conv } = make()
    const end = vi.fn()
    conv.start('NPC', '固定', [dlg('A', '1行目'), dlg('A', '2行目'), dlg(undefined, '3行目')], end)
    expect(conv.active).toBe(true)
    expect(dialog.shown).toEqual([['A', '1行目']])
    conv.advance() // タイプ中 → 全文
    expect(dialog.shown).toHaveLength(1)
    conv.advance() // 次へ
    expect(dialog.shown[1]).toEqual(['A', '2行目'])
    conv.advance()
    conv.advance()
    expect(dialog.shown[2]).toEqual(['', '3行目'])
    expect(conv.active).toBe(true)
    expect(end).not.toHaveBeenCalled()
    conv.advance()
    conv.advance()
    expect(conv.active).toBe(false)
    expect(dialog.isShowing).toBe(false)
    expect(end).toHaveBeenCalledTimes(1)
  })
  it('脚本: Wait の待ち中も会話中のまま、終わったら onEnd', () => {
    vi.useFakeTimers()
    try {
      const { conv } = make()
      const end = vi.fn()
      conv.start('NPC', '固定', [{ type: 'Wait', ms: 100 }], end)
      expect(conv.active).toBe(true)
      conv.advance() // Wait 中の送りは何も起こさない
      expect(conv.active).toBe(true)
      vi.advanceTimersByTime(100)
      expect(conv.active).toBe(false)
      expect(end).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('コマンドが無ければ固定 line（段階1と同じ。全文→閉じる）', () => {
    const { dialog, conv } = make()
    const end = vi.fn()
    conv.start('おばあさん', 'こんにちは。', undefined, end)
    expect(dialog.shown).toEqual([['おばあさん', 'こんにちは。']])
    expect(conv.active).toBe(true)
    conv.advance()
    expect(conv.active).toBe(true)
    conv.advance()
    expect(conv.active).toBe(false)
    expect(dialog.isShowing).toBe(false)
    expect(end).toHaveBeenCalledTimes(1)
  })
  it('会話中の start は無視する（二重起動で台詞・onEnd が壊れない）', () => {
    const { dialog, conv } = make()
    const end1 = vi.fn()
    const end2 = vi.fn()
    conv.start('A', '固定1', undefined, end1)
    conv.start('B', '固定2', [dlg('B', 'x')], end2)
    expect(dialog.shown).toEqual([['A', '固定1']])
    conv.advance()
    conv.advance()
    expect(end1).toHaveBeenCalledTimes(1)
    expect(end2).not.toHaveBeenCalled()
  })
  it('destroy で実行中の脚本を捨てる', () => {
    const { conv } = make()
    conv.start('A', '固定', [dlg('A', 'x')], () => {})
    expect(conv.active).toBe(true)
    conv.destroy()
    expect(conv.active).toBe(false)
  })
  it('会話していないときの advance は何もしない', () => {
    const { conv } = make()
    expect(() => conv.advance()).not.toThrow()
    expect(conv.active).toBe(false)
  })
})

describe('実パーサ経路 (parseMarkdown)', () => {
  it('[イベント] の複数行台詞を読み込み、scene で選んで実行できる', async () => {
    const md = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s:',
      '',
      '[イベント 老婆の話]',
      '**老婆**:',
      'こんにちは。',
      '',
      '**老婆**:',
      '気をつけてな。',
      '',
      '> 夜風が吹いた。',
      '[/イベント]',
      '',
    ].join('\n')
    const doc = await parseMarkdown(md)
    const events = collectFieldEvents(doc)
    const cmds = resolveNpcCommands('老婆の話', events, () => {})
    expect(cmds).toBeDefined()
    const dialog = fakeDialog()
    const conv = new FieldConversation(
      dialog,
      new EventRunner(
        dialog as never,
        createFieldNpcMover(() => {}),
        createFieldBattleHost(() => {})
      )
    )
    conv.start('NPC', '固定', cmds, () => {})
    let guard = 0
    while (conv.active && guard++ < 20) conv.advance()
    expect(dialog.shown.map((s) => s[1]).join('|')).toContain('こんにちは。')
    expect(dialog.shown).toEqual([
      ['老婆', 'こんにちは。'],
      ['老婆', '気をつけてな。'],
      ['', '夜風が吹いた。'],
    ])
    expect(conv.active).toBe(false)
  })
})

describe('Emotion の対応 (#946)', () => {
  const emo: EventCommand = { type: 'Emotion', target: '近所の子', kind: 'びっくり' }

  it('supportedCommands は Emotion を読み飛ばさず残す（警告なし）', () => {
    const warn = vi.fn()
    const cmds = [emo, dlg('子', 'やあ')]
    expect(supportedCommands('e', cmds, warn)).toEqual(cmds)
    expect(warn).not.toHaveBeenCalled()
  })

  it('Emotion と待機だけで台詞が無いイベントは固定 line に戻す', () => {
    expect(supportedCommands('e', [emo, { type: 'Wait', ms: 1 }], () => {})).toBeUndefined()
  })

  const ctx = () => ({
    emotions: {
      びっくり: {
        image: 'a.png',
        frames: 1,
        columns: 1,
        frameMs: 100,
        durationMs: 1000,
        offset: { x: 0, y: 0 },
        scale: 1,
        motion: 'none' as const,
      },
    },
    npcs: [{ id: 'kid', name: '近所の子' }],
  })

  it('createFieldEmotionHost: 解決して show に渡す。未解決は警告して show しない', () => {
    const show = vi.fn(() => true)
    const warn = vi.fn()
    const host = createFieldEmotionHost(ctx, show, warn)
    host.showEmotion('近所の子', 'びっくり', 700)
    expect(show).toHaveBeenCalledWith('npc:kid', 'びっくり', 700)
    host.showEmotion('主人公', 'びっくり')
    expect(show).toHaveBeenLastCalledWith('player', 'びっくり', undefined)
    host.showEmotion('幽霊', 'びっくり')
    host.showEmotion('主人公', '未宣言')
    expect(show).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('createFieldEmotionHost: show が false のとき原因を追える警告を 1 行出す', () => {
    const warn = vi.fn()
    createFieldEmotionHost(ctx, () => false, warn).showEmotion('近所の子', 'びっくり')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('近所の子')
    expect(warn.mock.calls[0][0]).toContain('びっくり')
  })

  it('実パーサ経路: parseMarkdown → EventRunner → emotionHost → show（台詞より先に・待たずに）', async () => {
    const md = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s:',
      '',
      '[イベント 子の話]',
      '[感情: 近所の子, びっくり]',
      '**近所の子**:',
      'わっ。',
      '',
      '[感情: 主人公, びっくり, 持続=900]',
      '[感情: 幽霊, びっくり]',
      '> 静かになった。',
      '[/イベント]',
      '',
    ].join('\n')
    const events = collectFieldEvents(await parseMarkdown(md))
    const cmds = resolveNpcCommands('子の話', events, () => {})
    expect(cmds?.map((c) => c.type)).toEqual([
      'Emotion',
      'Dialog',
      'Emotion',
      'Emotion',
      'Narration',
    ])
    const log: string[] = []
    const dialog = fakeDialog()
    const origShow = dialog.show
    dialog.show = ((...a: Parameters<typeof origShow>) => {
      log.push(`show:${a[1]}`)
      return origShow(...a)
    }) as typeof origShow
    const show = vi.fn((t: string, k: string, d?: number) => {
      log.push(`emo:${t}:${k}:${d ?? '-'}`)
      return true
    })
    const warn = vi.fn()
    const conv = new FieldConversation(
      dialog,
      new EventRunner(
        dialog as never,
        createFieldNpcMover(() => {}),
        createFieldBattleHost(() => {}),
        createFieldEmotionHost(ctx, show, warn)
      )
    )
    conv.start('NPC', '固定', cmds, () => {})
    let guard = 0
    while (conv.active && guard++ < 20) conv.advance()
    expect(log).toEqual([
      'emo:npc:kid:びっくり:-',
      'show:わっ。',
      'emo:player:びっくり:900',
      'show:静かになった。',
    ])
    expect(warn).toHaveBeenCalledTimes(1) // 幽霊
    expect(conv.active).toBe(false)
  })

  it('実パーサ: 台詞の途中の [感情:] のあとも同じ話者で続く（#946 レビュー）', async () => {
    const md = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## s:',
      '',
      '[イベント 子の話]',
      '**近所の子**:',
      'あっ！',
      '[感情: 近所の子, びっくり]',
      'なに？',
      '[/イベント]',
      '',
    ].join('\n')
    const cmds = collectFieldEvents(await parseMarkdown(md)).get('子の話')
    expect(
      cmds?.filter((c) => c.type === 'Dialog').map((c) => (c as { character?: string }).character)
    ).toEqual(['近所の子', '近所の子'])
  })
})
