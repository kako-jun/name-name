/**
 * 素材なしで動くフィールド＋戦闘のフィクスチャ (#890)。単色背景・矩形スプライトを canvas で作って data URI にする
 * （画像ファイルを repo に置かない・外部アセットサーバ不要）。`field-sample.html?fixture=dummy` で読む。
 * 設定の形は通常の設定 JSON と同じ（parseConfig に渡す）。ブラウザ（canvas）が要るので main.ts からだけ呼ぶ。
 */

/** 色つき矩形＋ラベルの PNG data URI */
function box(w: number, h: number, color: string, label: string, fontPx = 14): string {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) throw new Error('2D canvas を作れません')
  g.fillStyle = color
  g.fillRect(0, 0, w, h)
  g.strokeStyle = 'rgba(0,0,0,0.6)'
  g.lineWidth = 3
  g.strokeRect(1.5, 1.5, w - 3, h - 3)
  g.fillStyle = '#fff'
  g.font = `bold ${fontPx}px sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const lines = label.split('\n')
  lines.forEach((l, i) => g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * (fontPx + 4)))
  return c.toDataURL('image/png')
}

/** 野原風の背景（市松で奥行きを出さない単色＋縁取り） */
function field(w: number, h: number, color: string, label: string): string {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) throw new Error('2D canvas を作れません')
  g.fillStyle = color
  g.fillRect(0, 0, w, h)
  g.fillStyle = 'rgba(255,255,255,0.35)'
  g.font = 'bold 28px sans-serif'
  g.fillText(label, 16, 36)
  return c.toDataURL('image/png')
}

/** 歩行マスク（白=歩ける・黒=歩けない）。外周 16px だけ歩けない */
function mask(w: number, h: number): string {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) throw new Error('2D canvas を作れません')
  g.fillStyle = '#000'
  g.fillRect(0, 0, w, h)
  g.fillStyle = '#fff'
  g.fillRect(16, 16, w - 32, h - 32)
  return c.toDataURL('image/png')
}

/** 前面レイヤー (#866) の見本: 透明な画像に、通路の上へ吊った物（梁と吊り下げのブラウン管）だけを描く */
function overhead(w: number, h: number): string {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) throw new Error('2D canvas を作れません')
  g.fillStyle = '#c9a227'
  g.fillRect(180, 40, 280, 10) // 天井の梁
  g.fillStyle = '#444'
  g.fillRect(230, 50, 6, 70) // 吊り棒
  g.fillRect(404, 50, 6, 70)
  g.fillStyle = '#7a4aa8'
  g.fillRect(200, 120, 240, 80) // 吊られたブラウン管（足元が通路上でも頭〜体が隠れる高さ）
  g.fillStyle = '#fff'
  g.font = 'bold 20px sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('FRONT (hanging)', 320, 160)
  return c.toDataURL('image/png')
}

/** 電車内の背景 (#864)。窓（透明）から、奥の流れる景色が見える */
function trainInterior(w: number, h: number): string {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) throw new Error('2D canvas を作れません')
  g.fillStyle = '#8a6a48'
  g.fillRect(0, 0, w, h)
  g.fillStyle = '#5a4630'
  g.fillRect(0, 200, w, h - 200) // 床
  for (const x of [40, 240, 440]) g.clearRect(x, 40, 160, 110) // 窓（透明に抜く）
  g.fillStyle = 'rgba(255,255,255,0.6)'
  g.font = 'bold 22px sans-serif'
  g.fillText('DUMMY TRAIN', 220, 190)
  return c.toDataURL('image/png')
}

/** 窓の外の景色（横にタイルされる）。山と木を並べた帯 */
function landscape(w: number, h: number): string {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) throw new Error('2D canvas を作れません')
  g.fillStyle = '#7fc4e8'
  g.fillRect(0, 0, w, h)
  g.fillStyle = '#2d8a4a'
  g.fillRect(0, h - 36, w, 36)
  for (let x = 20; x < w; x += 80) {
    g.fillStyle = '#1d5a30'
    g.fillRect(x, h - 76, 14, 40)
    g.fillStyle = '#e0b030'
    g.fillRect(x - 8, h - 96, 30, 24)
  }
  return c.toDataURL('image/png')
}

/** 電車内の歩行マスク: 床の通路だけ歩ける */
function trainMask(w: number, h: number): string {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) throw new Error('2D canvas を作れません')
  g.fillStyle = '#000'
  g.fillRect(0, 0, w, h)
  g.fillStyle = '#fff'
  g.fillRect(16, 230, w - 32, h - 246)
  return c.toDataURL('image/png')
}

const FACING_COLOR = { up: '#3a6', down: '#36a', left: '#a63', right: '#a36' } as const
const POSE_COLOR: Record<string, string> = {
  idle: '#3b6bb5',
  ready: '#3b9bb5',
  step: '#3bb58a',
  slash: '#d6a02a',
  cast: '#9b4bd6',
  hurt: '#d65a2a',
  down: '#555555',
  victory: '#d6c42a',
}

function poses(prefix: string, w: number, h: number, colors: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(colors).map(([k, col]) => [k, box(w, h, col, `${prefix}\n${k}`, 12)])
  )
}

/** 設定 JSON のオブジェクトを作る */
export function buildDummyFixture(): Record<string, unknown> {
  const W = 640
  const H = 400
  const walk = Object.fromEntries(
    (['up', 'down', 'left', 'right'] as const).map((f) => [
      f,
      [1, 2, 3].map((n) => box(32, 48, FACING_COLOR[f], `${f[0].toUpperCase()}${n}`, 14)),
    ])
  )
  return {
    startScene: 'meadow',
    start: { x: 320, y: 300 },
    speed: 260,
    edgeThreshold: 6,
    player: { sprites: walk, height: 64, frameMs: 140 },
    scenes: {
      meadow: {
        background: field(W, H, '#2f5d3a', 'DUMMY FIELD'),
        mask: mask(W, H),
        foreground: overhead(W, H),
        links: [],
        encounter: { rate: 3, groups: ['slime', 'slime+bat', 'bat+bat'] },
      },
      train: {
        background: trainInterior(W, H),
        mask: trainMask(W, H),
        shake: { amplitudeY: 3, periodMs: 500 },
        scroll: { image: landscape(320, 110), speed: -240, y: 40 },
        links: [],
        encounter: { rate: 3, groups: ['slime', 'slime+bat', 'bat+bat'] },
      },
    },
    // ワープ (#864): 野原 ⇄ 電車内。電車内は揺れ・窓の外の流れる景色つきで、野原と同じ群でエンカウントする
    warps: {
      toTrain: { to: 'train', at: { x: 320, y: 300 }, facing: 'up', effect: 'fade' },
      toMeadow: { to: 'meadow', at: { x: 320, y: 300 }, facing: 'down', effect: 'flash' },
    },
    encounter: { stepDistance: 50, minSteps: 0 },
    monsters: {
      slime: {
        name: 'スライム',
        hp: 24,
        atk: 5,
        def: 1,
        agi: 3,
        exp: 5,
        gold: 3,
        sprite: box(96, 72, '#4aa84a', 'SLIME'),
        poses: poses('SLIME', 96, 72, { idle: '#4aa84a', hurt: '#d65a2a', down: '#555555' }),
      },
      bat: {
        name: 'こうもり',
        hp: 16,
        atk: 6,
        def: 1,
        agi: 8,
        exp: 4,
        gold: 2,
        sprite: box(96, 72, '#7a4aa8', 'BAT'),
        poses: poses('BAT', 96, 72, { idle: '#7a4aa8', hurt: '#d65a2a', down: '#555555' }),
      },
    },
    party: [
      {
        name: 'ゆうしゃ',
        hp: 40,
        mp: 6,
        atk: 9,
        def: 4,
        agi: 6,
        sprite: box(80, 112, POSE_COLOR.idle, 'HERO'),
        poses: poses('HERO', 80, 112, POSE_COLOR),
      },
      {
        name: 'まほうつかい',
        hp: 28,
        mp: 14,
        atk: 4,
        def: 2,
        agi: 7,
        sprite: box(80, 112, '#8a3bb5', 'MAGE'),
        poses: poses('MAGE', 80, 112, { ...POSE_COLOR, idle: '#8a3bb5' }),
      },
    ],
    // 候補窓 (#890)。メテオは MP 20 で誰も足りない（グレー確認用）。エーテルは所持数 0（グレー確認用）。
    // items の count は試作用の所持数で、本編の inventory ではない
    spells: [
      { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14 type=fire' },
      { id: 'thunder', name: 'いなずま', mp: 6, target: '敵全体', effect: 'damage 5..9' },
      { id: 'heal', name: 'ヒール', mp: 2, target: '味方単体', effect: 'heal 15..25' },
      { id: 'meteor', name: 'メテオ', mp: 20, target: '敵全体', effect: 'damage 30..40' },
    ],
    items: [
      { id: 'potion', name: 'ポーション', effect: 'heal 20..30', count: 3 },
      { id: 'ether', name: 'エーテル', effect: 'heal 1..1', count: 0 },
    ],
    battle: {
      layout: 'side',
      presentation: 'ff',
      windowStyle: 'ff-blue',
      commandLayout: 'cross',
      enemyGrid: '4x2',
      spriteStyle: 'none',
      width: 800,
      height: 450,
    },
  }
}
