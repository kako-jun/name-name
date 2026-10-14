/**
 * 一枚絵フィールド (#809) のランダムエンカウント抽選。純粋関数（乱数は注入）。DOM / PixiJS には触れない。
 *
 * 歩いた距離を貯め、stepDistance ごとに 1 回だけ抽選する（1 歩 = stepDistance の移動）。
 * 抽選そのものは既存の rollEncounter (#172) を再利用する。
 * 直前に戦闘があった直後は、minSteps 回分の抽選を飛ばす（連続エンカウントの抑制）。
 */
import type { MonsterDef } from '../types'
import type { BattleEntity } from './spellDsl'
import { rollEncounter } from './encounter'

/** 全シーン共通の歩数設定 */
export interface EncounterStepConfig {
  /** 抽選 1 回分の歩行距離（背景ピクセル） */
  stepDistance: number
  /** 戦闘後、この回数の抽選は飛ばす（0 で抑制なし） */
  minSteps: number
}

/** シーンごとの設定。rate は rollEncounter と同じ（0 = エンカウントなし・N = 1/N で当選・1 = 毎回） */
export interface SceneEncounter {
  rate: number
  /** モンスター群。`+` 連結でマスター id を並べる（例: "slime+slime"） */
  groups: string[]
}

/** 歩行中に変化する状態（プレーンな値のみ） */
export interface EncounterWalkState {
  /** 次の抽選までに貯めた距離 */
  distance: number
  /** 前回の戦闘（または開始）から経過した抽選回数。minSteps 未満の間は抽選を飛ばす */
  stepsSinceBattle: number
}

/** 開始時の状態。抑制なしで始める（stepsSinceBattle を minSteps に揃える） */
export function initialEncounterState(step: EncounterStepConfig): EncounterWalkState {
  return { distance: 0, stepsSinceBattle: step.minSteps }
}

/** 戦闘の直後の状態（貯めた距離を捨て、抑制を最初から数える） */
export function afterBattleState(): EncounterWalkState {
  return { distance: 0, stepsSinceBattle: 0 }
}

/**
 * walked だけ歩いたことを反映し、抽選回数に達した分だけ抽選する。当選したらそこで打ち切り、
 * 戦闘後の状態を返す。walked が 0（壁に押しつけて動けていない）なら何も変わらない。
 * scene が null（エンカウントなしのシーン）でも距離は貯めない。
 */
export function advanceEncounter(
  state: EncounterWalkState,
  walked: number,
  step: EncounterStepConfig,
  scene: SceneEncounter | null,
  masters: Record<string, MonsterDef>,
  rng: () => number
): { state: EncounterWalkState; enemies: BattleEntity[] | null } {
  if (
    !scene ||
    scene.rate === 0 ||
    !(walked > 0) ||
    !Number.isFinite(walked) ||
    step.stepDistance <= 0
  ) {
    return { state, enemies: null }
  }
  let distance = state.distance + walked
  let since = state.stepsSinceBattle
  while (distance >= step.stepDistance) {
    distance -= step.stepDistance
    if (since < step.minSteps) {
      since++
      continue
    }
    const enemies = rollEncounter({ rate: scene.rate, groups: scene.groups, masters, rng })
    if (enemies) return { state: afterBattleState(), enemies }
    since++
  }
  return { state: { distance, stepsSinceBattle: since }, enemies: null }
}
