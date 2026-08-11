//! rodio ベースの BGM/SE 再生（#502）。BGM/SE の音量制御は #503 で実装済み。
//!
//! GUI版 `AudioManager`（`frontend/src/game/AudioManager.ts`）が Web Audio API の
//! `AudioContext`/`GainNode` グラフで実現している機能のうち、TUI で必要な最小限
//! （BGM のループ再生・切り替え・停止、SE のワンショット複数同時再生、BGM/SE の音量制御）
//! だけを rodio の `OutputStream`/`Sink` で再現する。GUI版にあるフェード・動画ミックス・
//! キャプチャ配線は対象外（MVPスコープ、#502 の実装方針コメント参照）。ボイス音量の
//! バックエンド反映も対象外——GUI版 `voiceVolume`（「#144 ボイス用、現在は保存だけ」）と
//! 同じ割り切りで、TUI側にもボイス再生コード自体が存在しないため
//! （`config::VolumeConfig` のdoc comment参照）。
//!
//! ## フェード無し（即時切り替え）
//!
//! GUI版 `playBgm`/`stopBgm` は `fade_ms` に応じて `GainNode` を線形補間するが、TUI 版は
//! #512（暗転）が「TUIはフェードを持たずGUIと違い瞬時切替」とした判断基準をそのまま踏襲し、
//! フェード無しの即時切り替えにする。フェードタイマーを別スレッド/フレームで管理する複雑さに
//! 見合う効果が、テキストベースUIでは薄いため。
//!
//! ## 音声出力デバイスが無い環境への配慮
//!
//! SSH経由・headless環境等で `OutputStream::try_default()` が失敗しうる。この場合
//! `AudioPlayer::try_new` が `None` を返し、呼び出し側（`main.rs`）は音声再生機能を丸ごと
//! 無効化して進行を続ける（エラーにしない）。既存の TUI が画像デコード失敗時にプレースホルダへ
//! フォールバックする設計・#512 暗転が持つ fail-soft 方針と同じ思想。

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};

use crate::config::{self, percent_to_volume_scale};

/// BGM/SE の再生を担うプレイヤー。`OutputStream` はドロップされるとデバイスが閉じるため、
/// 生存期間中ずっと保持し続ける必要がある（rodio の制約、`_stream` の命名は未使用警告除けと
/// 保持目的を兼ねる標準的なパターン）。
pub struct AudioPlayer {
    _stream: OutputStream,
    stream_handle: OutputStreamHandle,
    /// 現在ループ再生中の BGM の `Sink`。`None` は無音状態。
    bgm_sink: Option<Sink>,
    /// BGM の音量（0.0〜1.0）。`try_new` の引数 `volume` から `initial_volumes` 経由で
    /// 生成直後に必ず反映される（フィールドdoc・`try_new`のdoc comment参照）。
    bgm_volume: f32,
    /// SE の音量（0.0〜1.0）。`bgm_volume` と同じく `try_new` の引数から生成直後に反映される。
    se_volume: f32,
}

impl AudioPlayer {
    /// 音声出力デバイスを初期化し、`volume` の値を生成と同時に反映した状態で返す
    /// （#502／起動時同期は#537）。デバイスが無い・初期化に失敗した環境（SSH経由・headless等）
    /// では `None` を返す — 呼び出し側はこれをエラーとして扱わず、音声再生機能全体を
    /// 無効化して続行すること（#502 実装方針）。
    ///
    /// **生成と音量同期を1つの関数に統合しているのは意図的（#537セルフレビュー指摘への対応）**。
    /// 以前は `try_new()`（引数無し、暫定値 1.0 で生成）→ `main.rs::run()` が別途
    /// `sync_startup_volume(...)` を呼ぶ、という2段階の設計だった。しかし `run()` は
    /// raw mode/alternate screen 等の端末副作用を持ちテスト不能なため、後者の呼び出し行を
    /// 削除しても `cargo test` は気づけない——実際、削除してテストを回しても640件全てパスする
    /// ことを確認した上でこの設計に変更した。`try_new` の唯一の公開シグネチャが
    /// `&config::VolumeConfig` を要求する形にすることで、「音量を渡さずに `AudioPlayer` を
    /// 生成する」という経路自体をコンパイラが許さない（呼び出し漏れというバグのクラスが
    /// 構造的に起こり得ない）。内部の値計算は `initial_volumes`（ハードウェア非依存の純粋関数）
    /// に切り出してあり、これは実デバイスが無いCI環境でも直接テストできる
    /// （`initial_volumes` 呼び出しを削ってフィールドをハードコードし直すような回帰が起きた
    /// 場合、`volume` 引数が未使用になり `cargo clippy -- -D warnings` がCIで検知する）。
    pub fn try_new(volume: &config::VolumeConfig) -> Option<Self> {
        let (stream, stream_handle) = OutputStream::try_default().ok()?;
        let (bgm_volume, se_volume) = Self::initial_volumes(volume);
        Some(Self {
            _stream: stream,
            stream_handle,
            bgm_sink: None,
            bgm_volume,
            se_volume,
        })
    }

    /// `volume` から初期BGM/SE音量（0.0〜1.0）を計算する（#537）。`try_new` が唯一の
    /// 呼び出し元で、戻り値をそのまま構造体リテラルの `bgm_volume`/`se_volume` フィールドに
    /// 埋め込む。`OutputStream`（実オーディオデバイス）に依存しない純粋関数なので、
    /// 実デバイスが無いCI環境でも `initial_volumes_maps_bgm_and_se_percent_independently`
    /// 等のテストで直接検証できる（`try_new` のdoc comment参照）。
    fn initial_volumes(volume: &config::VolumeConfig) -> (f32, f32) {
        (
            percent_to_volume_scale(volume.bgm_percent),
            percent_to_volume_scale(volume.se_percent),
        )
    }

    /// BGM の音量を変更する（0.0〜1.0、#503）。値を保持するだけでなく、現在ループ再生中の
    /// BGM（`bgm_sink` が `Some`）があれば `Sink::set_volume` で即座に反映する — GUI版
    /// `AudioManager` の音量スライダーが再生中のBGMへリアルタイムに効くのと同じ体験。
    pub fn set_bgm_volume(&mut self, volume: f32) {
        self.bgm_volume = volume;
        if let Some(sink) = &self.bgm_sink {
            sink.set_volume(volume);
        }
    }

    /// SE の音量を変更する（0.0〜1.0、#503）。SE は `play_se` 呼び出しのたびに新規 `Sink` を
    /// 作って即座に `detach()` する fire-and-forget 設計のため、再生中のSEへ遡って反映する
    /// 手段が無い——値を保持し、次回以降の `play_se` 呼び出しから適用される。
    pub fn set_se_volume(&mut self, volume: f32) {
        self.se_volume = volume;
    }

    /// `path` の BGM をループ再生に切り替える。既に再生中の BGM があれば即座に停止する
    /// （GUI版 `playBgm` の `stopBgmImmediate()` 相当。フェードは行わない、モジュール冒頭
    /// doc comment参照）。ファイルが存在しない・デコードに失敗した場合は何もしない
    /// （進行は止めない、`resolve_sound_path` が返す実パスをそのまま渡す想定）。
    pub fn play_bgm(&mut self, path: &Path) {
        self.stop_bgm();
        let Some(source) = decode_file(path) else {
            return;
        };
        let Ok(sink) = Sink::try_new(&self.stream_handle) else {
            return;
        };
        sink.set_volume(self.bgm_volume);
        sink.append(source.repeat_infinite());
        self.bgm_sink = Some(sink);
    }

    /// 再生中の BGM を即座に停止する（フェード無し）。既に無音なら no-op。
    pub fn stop_bgm(&mut self) {
        if let Some(sink) = self.bgm_sink.take() {
            sink.stop();
        }
    }

    /// `path` の SE をワンショット再生する。複数同時再生可能（GUI版 `playSe` と同じ、
    /// 呼び出しごとに独立した `Sink` を使う）。`Sink::detach()` で再生完了を待たずに
    /// 呼び出し元へ返り、バックグラウンドで鳴り終える（fire-and-forget）。ファイルが
    /// 存在しない・デコードに失敗した場合は何もしない。
    pub fn play_se(&self, path: &Path) {
        let Some(source) = decode_file(path) else {
            return;
        };
        let Ok(sink) = Sink::try_new(&self.stream_handle) else {
            return;
        };
        sink.set_volume(self.se_volume);
        sink.append(source);
        sink.detach();
    }
}

/// ファイルを開いて rodio の `Decoder` に通す。ファイルI/Oエラー・未対応/壊れたフォーマットの
/// 両方を `None` に丸め込み、呼び出し側で分岐せず一様に「鳴らせなかった」として扱えるようにする。
fn decode_file(path: &Path) -> Option<Decoder<BufReader<File>>> {
    let file = File::open(path).ok()?;
    Decoder::new(BufReader::new(file)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::VolumeConfig;

    // ---- #537: 起動時音量同期（`AudioPlayer::try_new` / `initial_volumes`）----
    //
    // CI環境には実オーディオデバイスが無く `OutputStream::try_default()` は常に失敗するため、
    // 実際に `AudioPlayer::try_new` を呼んで `Some` を得るテストは書けない（`try_new` の
    // doc comment参照）。かわりに、`try_new` が唯一呼ぶ純粋関数 `initial_volumes` を直接
    // 検証する。`try_new` は `initial_volumes` の戻り値をそのまま構造体リテラルの
    // `bgm_volume`/`se_volume` フィールドへ埋め込むだけなので、この関数さえ正しければ
    // 生成される `AudioPlayer` の初期音量も正しい。

    #[test]
    fn initial_volumes_maps_default_config_to_bgm_and_se_scale() {
        // デフォルトconfig(bgm=70%/se=80%)から0.70/0.80が計算されることを確認する
        // （#537再発防止の主テスト）。
        let volume = VolumeConfig::default();
        assert_eq!(AudioPlayer::initial_volumes(&volume), (0.70, 0.80));
    }

    #[test]
    fn initial_volumes_maps_boundary_zero_and_max_without_swapping_bgm_and_se() {
        // 境界値: 下限0%/上限100%が両方向で正しく変換され、bgm/seが入れ替わらないことを
        // クロスの2パターンで確認する。
        let low_bgm_high_se = VolumeConfig {
            bgm_percent: 0,
            se_percent: 100,
            voice_percent: 80,
        };
        assert_eq!(AudioPlayer::initial_volumes(&low_bgm_high_se), (0.0, 1.0));

        let high_bgm_low_se = VolumeConfig {
            bgm_percent: 100,
            se_percent: 0,
            voice_percent: 80,
        };
        assert_eq!(AudioPlayer::initial_volumes(&high_bgm_low_se), (1.0, 0.0));
    }
}
