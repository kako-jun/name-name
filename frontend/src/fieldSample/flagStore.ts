/**
 * フラグ (#862) の値と、画面のチェックボックスの対応。
 * フラグ名は任意の文字列（`"` や `]` を含み得る）なので、CSS セレクタで引かず Map で持つ。
 */
import { hasOwn } from '../game/ownProperty'

export interface FlagBox {
  checked: boolean
}

export interface FlagStore {
  /** 現在の値（読み取り専用の想定。変えるときは set を使う） */
  flags: Record<string, boolean>
  /** 宣言済みのフラグに対応するチェックボックスを登録する */
  register(name: string, box: FlagBox): void
  /** 宣言済みなら値を変えて対応するチェックボックスも更新し true。未宣言なら何も変えず false */
  set(name: string, value: boolean): boolean
}

export function createFlagStore(initial: Readonly<Record<string, boolean>>): FlagStore {
  const flags: Record<string, boolean> = { ...initial }
  const boxes = new Map<string, FlagBox>()
  return {
    flags,
    register(name, box) {
      boxes.set(name, box)
    },
    set(name, value) {
      if (!hasOwn(flags, name)) return false
      const box = boxes.get(name)
      if (box) box.checked = value
      flags[name] = value
      return true
    },
  }
}
