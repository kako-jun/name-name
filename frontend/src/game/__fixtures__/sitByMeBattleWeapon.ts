/**
 * sit-by-me の実データの抜粋（#1027 の実データテスト用フィクスチャ。値は実物のまま、必要な項目だけ残した）。
 * 出典: https://github.com/kako-jun/sit-by-me  commit b0d6c12854677d29a8d55794ad625164eec819f4 (main, 2026-11-04)
 *   - assets/images/characters/C00{1..4}/battle-layers.json   → LAYERS_C00x（pose_layers の ready / step / slash / swing-* / special / cast と ready_weapon_transform）
 *   - assets/images/weapons/C00{1..4}/C00x-blade-candidates.json → CATALOG_C00x（weapons の file / handle_center_normalized）。C001 だけ shared_pose_transforms.poses.slash（候補刀別の上書き）も残す
 * 契約の正本は sit-by-me の docs/assets-policy.md「戦闘人物と刀の合成」。ここは値の複写で、正本ではない（sit-by-me 側が変わったら更新する）。
 */
export const LAYERS_C001 = {
  pose_layers: {
    ready: ['character', 'weapon'],
    step: {
      standing: {
        layers: ['character', 'weapon'],
        weapon_height_ratio: 0.42,
        flip_x: true,
        rotation_deg: 25,
        handle_target: {
          x: 0.7,
          y: 0.38,
        },
      },
      wheelchair: {
        layers: ['movement_streak', 'character'],
        weapon: 'none; hands stay on pushrims',
        movement_anchor: {
          x: 0.53,
          y: 0.61,
        },
      },
    },
    slash: {
      layers: ['trail', 'character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.52,
        wheelchair: 0.42,
      },
      rotation_deg: 45,
      handle_target: {
        standing: {
          x: 0.56,
          y: 0.48,
        },
        wheelchair: {
          x: 0.5,
          y: 0.34,
        },
      },
    },
    'swing-windup': {
      layers: ['character', 'weapon'],
      weapon_height_ratio: 0.52,
      rotation_deg: -90,
      handle_target: {
        standing: {
          x: 0.76,
          y: 0.25,
        },
        wheelchair: {
          x: 0.8,
          y: 0.26,
        },
      },
      flip_x: false,
      source:
        'copied from assets/images/weapons/C001/C001-blade-candidates.json#shared_pose_transforms.poses (values identical)',
    },
    'swing-followthrough': {
      layers: ['character', 'weapon'],
      weapon_height_ratio: 0.52,
      rotation_deg: 90,
      handle_target: {
        standing: {
          x: 0.22,
          y: 0.64,
        },
        wheelchair: {
          x: 0.28,
          y: 0.43,
        },
      },
      flip_x: false,
      source:
        'copied from assets/images/weapons/C001/C001-blade-candidates.json#shared_pose_transforms.poses (values identical)',
    },
    special: {
      layers: ['trail', 'character', 'weapon'],
      weapon_height_ratio: 0.57,
      rotation_deg: -20,
      handle_target: {
        standing: {
          x: 0.53,
          y: 0.1,
        },
        wheelchair: {
          x: 0.48,
          y: 0.08,
        },
      },
    },
    cast: {
      layers: ['character_with_phone', 'phone_glow'],
      phone_glow_center: {
        kindergarten_standing: {
          x: 0.14,
          y: 0.09,
        },
        elementary_standing: {
          x: 0.29,
          y: 0.27,
        },
        wheelchair: {
          x: 0.14,
          y: 0.28,
        },
      },
    },
  },
  ready_weapon_transform: {
    weapon_height_ratio: 0.72,
    rotation_deg: 0,
    handle_target: {
      standing: {
        x: 0.4,
        y: 0.38,
      },
      wheelchair: {
        x: 0.3,
        y: 0.36,
      },
    },
  },
} as const
export const CATALOG_C001 = {
  weapons: [
    {
      file: 'C001-odenta-mitsuyo-candidate.webp',
      handle_center_normalized: {
        x: 0.846,
        y: 0.836,
      },
    },
    {
      file: 'C001-juzumaru-tsunetsugu-candidate.webp',
      handle_center_normalized: {
        x: 0.87,
        y: 0.83,
      },
    },
    {
      file: 'C001-sohaya-no-tsuruki-candidate.webp',
      handle_center_normalized: {
        x: 0.89,
        y: 0.85,
      },
    },
    {
      file: 'C001-mikazuki-munechika-candidate.webp',
      handle_center_normalized: {
        x: 0.934,
        y: 0.853,
      },
    },
    {
      file: 'C001-onimaru-kunitsuna-candidate.webp',
      handle_center_normalized: {
        x: 0.935,
        y: 0.87,
      },
    },
  ],
  shared_pose_transforms: {
    poses: {
      slash: {
        weapon_anchor: 'handle_center_normalized',
        rotation_deg: 45,
        handle_target: {
          standing: {
            x: 0.56,
            y: 0.48,
          },
          wheelchair: {
            x: 0.5,
            y: 0.34,
          },
        },
        weapon_height_ratio: {
          standing: 0.52,
          wheelchair: 0.42,
        },
        candidate_overrides: {
          'C001-onimaru-kunitsuna-candidate.webp': {
            weapon_height_ratio: {
              standing: 0.48,
              wheelchair: 0.42,
            },
            handle_target: {
              standing: {
                x: 0.72,
                y: 0.48,
              },
              wheelchair: {
                x: 0.62,
                y: 0.34,
              },
            },
            reason:
              'Longer horizontal projection; shared across generations to keep the full sword tip inside the frame.',
          },
        },
      },
    },
  },
} as const
export const LAYERS_C002 = {
  pose_layers: {
    ready: ['character', 'weapon'],
    step: {
      standing: {
        layers: ['character', 'weapon'],
        weapon_height_ratio: 0.42,
        flip_x: false,
        rotation_deg: -205,
        handle_target: {
          x: 0.09,
          y: 0.4,
        },
      },
      wheelchair: {
        layers: ['character'],
        weapon: 'none; hands stay on pushrims',
      },
    },
    slash: {
      layers: ['character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.48,
        wheelchair: 0.42,
      },
      rotation_deg: -150,
      handle_target: {
        standing: {
          x: 0.16,
          y: 0.3,
        },
        wheelchair: {
          x: 0.15,
          y: 0.34,
        },
      },
      flip_x: false,
    },
    'swing-windup': {
      layers: ['character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.42,
        wheelchair: 0.38,
      },
      rotation_deg: -210,
      handle_target: {
        standing: {
          x: 0.12,
          y: 0.26,
        },
        wheelchair: {
          x: 0.22,
          y: 0.29,
        },
      },
      flip_x: false,
    },
    'swing-followthrough': {
      layers: ['character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.42,
        wheelchair: 0.38,
      },
      rotation_deg: -175,
      handle_target: {
        standing: {
          x: 0.1,
          y: 0.54,
        },
        wheelchair: {
          x: 0.08,
          y: 0.53,
        },
      },
      flip_x: false,
    },
    special: {
      layers: ['character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.45,
        wheelchair: 0.4,
      },
      rotation_deg: -200,
      handle_target: {
        standing: {
          x: 0.09,
          y: 0.1,
        },
        wheelchair: {
          x: 0.12,
          y: 0.1,
        },
      },
      flip_x: false,
    },
    cast: ['character'],
  },
  ready_weapon_transform: {
    weapon_height_ratio: {
      standing: 0.45,
      wheelchair: 0.4,
    },
    rotation_deg: -205,
    handle_target: {
      standing: {
        x: 0.17,
        y: 0.25,
      },
      wheelchair: {
        x: 0.28,
        y: 0.26,
      },
    },
    flip_x: false,
    note: 'canonical ready transform; pose_layers.ready is the layer list only (same as C001)',
  },
} as const
export const CATALOG_C002 = {
  weapons: [
    {
      file: 'C002-heshikiri-hasebe-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
    {
      file: 'C002-honebami-toshiro-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
    {
      file: 'C002-yoshimoto-samonji-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
    {
      file: 'C002-yamanbagiri-kunihiro-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
    {
      file: 'C002-muramasa-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
  ],
} as const
export const LAYERS_C003 = {
  pose_layers: {
    ready: ['character', 'weapon'],
    step: {
      standing: {
        layers: ['character', 'weapon'],
        weapon_height_ratio: 0.38,
        flip_x: false,
        rotation_deg: -155,
        handle_target: {
          x: 0.18,
          y: 0.6,
        },
      },
    },
    slash: {
      layers: ['character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.48,
      },
      rotation_deg: 45,
      handle_target: {
        standing: {
          x: 0.58,
          y: 0.53,
        },
      },
      flip_x: false,
    },
    'swing-windup': {
      layers: ['character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.31,
      },
      rotation_deg: 35,
      handle_target: {
        standing: {
          x: 0.66,
          y: 0.44,
        },
      },
      flip_x: false,
    },
    'swing-followthrough': {
      layers: ['character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.4,
      },
      rotation_deg: -155,
      handle_target: {
        standing: {
          x: 0.22,
          y: 0.56,
        },
      },
      flip_x: false,
    },
    special: {
      layers: ['character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.4,
      },
      rotation_deg: -250,
      handle_target: {
        standing: {
          x: 0.78,
          y: 0.13,
        },
      },
      flip_x: false,
    },
    cast: ['character'],
  },
  ready_weapon_transform: {
    weapon_height_ratio: {
      standing: 0.42,
    },
    rotation_deg: -5,
    handle_target: {
      standing: {
        x: 0.63,
        y: 0.57,
      },
    },
    flip_x: false,
    note: 'canonical ready transform; pose_layers.ready is the layer list only (same as C001)',
  },
} as const
export const CATALOG_C003 = {
  weapons: [
    {
      file: 'C003-nagasone-kotetsu-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
    {
      file: 'C003-minamoto-kiyomaro-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
    {
      file: 'C003-suishinshi-masahide-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
    {
      file: 'C003-izuminokami-kanesada-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
    {
      file: 'C003-kashu-kiyomitsu-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
  ],
} as const
export const LAYERS_C004 = {
  pose_layers: {
    ready: ['character', 'weapon'],
    step: {
      standing: {
        layers: ['character', 'weapon'],
        weapon_height_ratio: 0.4,
        flip_x: false,
        rotation_deg: -205,
        handle_target: {
          x: 0.1,
          y: 0.56,
        },
      },
    },
    slash: {
      layers: ['character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.48,
      },
      rotation_deg: 45,
      handle_target: {
        standing: {
          x: 0.52,
          y: 0.53,
        },
      },
      flip_x: false,
    },
    'swing-windup': {
      layers: ['character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.4,
      },
      rotation_deg: 15,
      handle_target: {
        standing: {
          x: 0.62,
          y: 0.4,
        },
      },
      flip_x: false,
    },
    'swing-followthrough': {
      layers: ['character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.4,
      },
      rotation_deg: -155,
      handle_target: {
        standing: {
          x: 0.3,
          y: 0.56,
        },
      },
      flip_x: false,
    },
    special: {
      layers: ['character', 'weapon'],
      weapon_height_ratio: {
        standing: 0.34,
      },
      rotation_deg: -210,
      handle_target: {
        standing: {
          x: 0.48,
          y: 0.08,
        },
      },
      flip_x: false,
    },
    cast: ['character'],
  },
  ready_weapon_transform: {
    weapon_height_ratio: {
      standing: 0.42,
    },
    rotation_deg: -205,
    handle_target: {
      standing: {
        x: 0.16,
        y: 0.3,
      },
    },
    flip_x: false,
    note: 'canonical ready transform; pose_layers.ready is the layer list only (same as C001)',
  },
} as const
export const CATALOG_C004 = {
  weapons: [
    {
      file: 'C004-shichishito-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
    {
      file: 'C004-kinsaku-mei-tetsuken-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
    {
      file: 'C004-ginzougan-mei-tachi-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
    {
      file: 'C004-chuuhei-mei-tetsutou-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
    {
      file: 'C004-shichiseiken-candidate.webp',
      handle_center_normalized: {
        x: 0.82,
        y: 0.82,
      },
    },
  ],
} as const
