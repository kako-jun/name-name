import { describe, it, expect } from 'vitest'
import { __internal, PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION } from './scriptContentCache'

// #340: 本文の表示用ダイグラフ正準化（`--`→`──` / `…`→`⋯`）を parser に追加したため、
// キャッシュ済み EventDocument（parseMarkdown/normalizeEvents を経ずに直接復元される経路）の
// スキーマを 1→2 に上げ、旧ドキュメント（素の `--`/`…`）を別キーに孤立させて再パースを強制した。
// この隔離機構（schema バージョンをキーに織り込む）を、IndexedDB 非依存の純粋なキー導出関数
// （__internal.buildDocumentKey）だけで恒久的に固定する。
describe('scriptContentCache ドキュメントキーの schema バージョン隔離 (#340)', () => {
  const keyParts = { projectName: 'demo', ref: 'main', path: 'chapter1.md', sha: 'abc123' }

  // G1-a: schema 1 と 2 でキーが異なる = 旧#340前ドキュメントは現行キーにヒットせず孤立し、
  //       parseMarkdown 経由の再パース（正準化あり）が強制される。
  it('G1: schema version 1 と 2 でドキュメントキーが異なる（旧ドキュメントを孤立させ再パース強制）', () => {
    const v1 = __internal.buildDocumentKey(keyParts, 1)
    const v2 = __internal.buildDocumentKey(keyParts, 2)
    expect(v1).not.toBe(v2)
  })

  // G1-b: 現行スキーマは 2 で、キーに `schema:2` を織り込む。旧 1 は別枠 `schema:1` に隔離される。
  //       正準化導入で 1→2 に上げた機構そのものを固定する（誤って据え置くと旧素値が復活する）。
  it('G1: 現行ドキュメントキーは schema:2 を含み、旧 schema:1 とは別枠に隔離される', () => {
    expect(PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION).toBe(2)
    const current = __internal.buildDocumentKey(keyParts, PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION)
    expect(current).toContain('schema:2')
    expect(__internal.buildDocumentKey(keyParts, 1)).toContain('schema:1')
  })
})
