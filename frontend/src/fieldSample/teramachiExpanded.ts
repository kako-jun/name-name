/**
 * 寺町サンプルの設定 JSON を、人物の形態の導出（#1020）まで済ませた文字列にして返す。テスト用（`main.ts` の `loadConfig` と同じ手順を同期で行う）。
 * `teramachi.sample.json` は `party[].poses` と `player.sprites` を持たず、目録（`sit-character-forms.json`）から導く。
 */
import sampleText from './teramachi.sample.json?raw'
import manifestText from '../../public/field-sample/sit-character-forms.json?raw'
import { expandCharacterForms, parseCharacterFormsManifest } from './characterForms'

export function expandedTeramachiText(savedForms: Record<string, string> = {}): string {
  const m = parseCharacterFormsManifest(JSON.parse(manifestText))
  if (!m.ok) throw new Error(m.error)
  return JSON.stringify(expandCharacterForms(JSON.parse(sampleText), m.value, savedForms).raw)
}
