import type { FieldScriptEvents } from '../game/fieldScript'

/**
 * NPC の脚本（`[イベント]`）の供給元の決め方（startFieldGame の `scriptEvents` オプションと設定の `scriptUrl`）。
 * 呼び出し側が脚本を渡す（`provided`）なら取得（`load`）は呼ばず、そちらを使う。無ければ従来どおり `load`（= `scriptUrl` の取得）
 */
export async function pickScriptEvents(
  provided: FieldScriptEvents | undefined,
  load: () => Promise<FieldScriptEvents | undefined>
): Promise<FieldScriptEvents | undefined> {
  return provided ?? (await load())
}

/**
 * 起動時の `scene` と脚本の照合の警告を出すか。脚本の供給元がある（渡された、または `scriptUrl` がある）ときだけ。
 * 供給元が無いときは config 段階（parseConfig の「scriptUrl がありません」）で警告済み
 */
export function shouldCheckNpcScripts(
  provided: FieldScriptEvents | undefined,
  scriptUrl: string | undefined
): boolean {
  return provided !== undefined || !!scriptUrl
}
