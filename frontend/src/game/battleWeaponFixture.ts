/**
 * 武器レイヤー (#1027) のテスト用の架空の契約 JSON（スキーマの項目名だけ実物と同じ。キャラ名・刀名・数値は架空）。
 * 単体テストと画面テストで共有する。
 */
export const DUMMY_LAYERS = {
  pose_layers: {
    idle: ['character'],
    ready: ['character', 'weapon'],
    step: {
      standing: {
        layers: ['character', 'weapon'],
        weapon_height_ratio: 0.4,
        flip_x: true,
        rotation_deg: 20,
        handle_target: { x: 0.7, y: 0.4 },
      },
      wheelchair: { layers: ['movement_streak', 'character'], weapon: 'none; hands stay on rims' },
    },
    slash: {
      layers: ['trail', 'character', 'weapon'],
      weapon_height_ratio: { standing: 0.52, wheelchair: 0.4 },
      rotation_deg: 45,
      handle_target: { standing: { x: 0.56, y: 0.48 }, wheelchair: { x: 0.45, y: 0.35 } },
    },
    'swing-windup': {
      layers: ['character', 'weapon'],
      weapon_height_ratio: { standing: 0.52, wheelchair: 0.4 },
      rotation_deg: -90,
      handle_target: { standing: { x: 0.76, y: 0.25 }, wheelchair: { x: 0.8, y: 0.26 } },
      flip_x: false,
    },
    'swing-followthrough': {
      layers: ['character', 'weapon'],
      weapon_height_ratio: { standing: 0.52, wheelchair: 0.4 },
      rotation_deg: 90,
      handle_target: { standing: { x: 0.22, y: 0.64 }, wheelchair: { x: 0.28, y: 0.43 } },
      flip_x: false,
    },
    hurt: ['magic_burst', 'character'],
    down: ['character'],
    cast: { layers: ['character_with_phone', 'phone_glow'] },
    special: {
      layers: ['trail', 'character', 'weapon'],
      weapon_height_ratio: 0.55,
      rotation_deg: -20,
      handle_target: { standing: { x: 0.5, y: 0.1 }, wheelchair: { x: 0.45, y: 0.1 } },
    },
  },
  ready_weapon_transform: {
    weapon_height_ratio: 0.7,
    rotation_deg: 0,
    handle_target: { standing: { x: 0.4, y: 0.4 }, wheelchair: { x: 0.3, y: 0.35 } },
  },
}

export const DUMMY_CATALOG = {
  weapons: [
    { file: 'dummy-blade-a.webp', handle_center_normalized: { x: 0.8, y: 0.8 } },
    { file: 'dummy-blade-b.webp', handle_center_normalized: { x: 0.9, y: 0.85 } },
  ],
}
