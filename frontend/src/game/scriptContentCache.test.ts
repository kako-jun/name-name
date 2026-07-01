import { describe, it, expect } from 'vitest'
import { __internal, PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION } from './scriptContentCache'

// #340: 本文の表示用ダイグラフ正準化（`--`→`──` / `…`→`⋯`）を parser に追加したため、
// キャッシュ済み EventDocument（parseMarkdown/normalizeEvents を経ずに直接復元される経路）の
// スキーマを上げ、旧ドキュメント（素の `--`/`…`）を別キーに孤立させて再パースを強制した。
// parse 出力（正規形）が変わるたびに bump する: 1→2（Dialog/Narration/Choice/TitleShow/Label）→
// 3（RpgEvent 内会話も正準化・#340 完全形）。この隔離機構（schema バージョンをキーに織り込む）を、
// IndexedDB 非依存の純粋なキー導出関数（__internal.buildDocumentKey）だけで恒久的に固定する。
describe('scriptContentCache ドキュメントキーの schema バージョン隔離 (#340)', () => {
  const keyParts = { projectName: 'demo', ref: 'main', path: 'chapter1.md', sha: 'abc123' }

  // G1-a: schema 1 と現行版でキーが異なる = 旧#340前ドキュメントは現行キーにヒットせず孤立し、
  //       parseMarkdown 経由の再パース（正準化あり）が強制される。
  it('G1: schema version 1 と現行版でドキュメントキーが異なる（旧ドキュメントを孤立させ再パース強制）', () => {
    const v1 = __internal.buildDocumentKey(keyParts, 1)
    const current = __internal.buildDocumentKey(keyParts, PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION)
    expect(v1).not.toBe(current)
  })

  // G1-b: 現行スキーマは 3 で、キーに `schema:3` を織り込む。旧 1 は別枠 `schema:1` に隔離される。
  //       正準化拡張のたびに bump する機構そのものを固定する（据え置くと旧素値が復活する）。
  it('G1: 現行ドキュメントキーは schema:3 を含み、旧 schema:1 とは別枠に隔離される', () => {
    expect(PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION).toBe(3)
    const current = __internal.buildDocumentKey(keyParts, PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION)
    expect(current).toContain('schema:3')
    expect(__internal.buildDocumentKey(keyParts, 1)).toContain('schema:1')
  })
})
