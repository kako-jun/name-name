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
        let (stream, stream_handle) = with_stderr_suppressed(OutputStream::try_default).ok()?;
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

/// `with_stderr_suppressed` がリダイレクト成功後に保持する RAII ガード。`f` が正常終了しても
/// panic しても、スタックアンワインド中に `Drop::drop` が必ず呼ばれるため、手続き的な
/// cleanup（dup2 での復元 → 退避fdのclose）と違って「`f` の途中で抜ける」経路を取りこぼさない
/// （#559 セルフレビュー指摘）。
#[cfg(unix)]
struct StderrGuard {
    stderr_fd: std::os::unix::io::RawFd,
    saved_fd: std::os::unix::io::RawFd,
}

#[cfg(unix)]
impl Drop for StderrGuard {
    fn drop(&mut self) {
        // dup2 の戻り値は捨てる（Drop 内なので失敗しても分岐のしようがなく、panicも
        // できない — panic中にさらにpanicするとプロセスがabortする）。復元に失敗した
        // 場合、ログ出力先のstderr自体が壊れている可能性が高くこちらから通知する術も
        // 無いため、ベストエフォートとして退避fdのcloseだけは試みてリークを避ける。
        let _ = unsafe { libc::dup2(self.saved_fd, self.stderr_fd) };
        unsafe { libc::close(self.saved_fd) };
    }
}

/// `f` 実行中だけプロセスの stderr（fd 2）を `/dev/null` へ一時的にリダイレクトする。
///
/// ALSA/JACK 等の C ライブラリは、デバイスが無い・接続できない環境で `snd_config_get_card`
/// や `cannot connect ... to system:playback_1` のようなログを直接 stderr へ書き込む。これは
/// Rust の `Result` を経由しない出力経路のため、`OutputStream::try_default()` 側の `.ok()` では
/// 抑制できない。TUI は stdout を raw mode の alternate screen として使っているが stderr は
/// 素通しで同一端末に出力されるため、両者が衝突して画面が乱れる（#559）。
///
/// リダイレクト対象は `f` の実行中だけに限定し、それ以外のログ出力（アプリ自体の panic
/// メッセージ等）を巻き込まないようスコープを絞る。Unix限定。非Unix環境ではこの問題自体が
/// 起きない（cpal は Windows で WASAPI バックエンドを使う）ため、素通しで `f` を実行する。
#[cfg(unix)]
fn with_stderr_suppressed<T>(f: impl FnOnce() -> T) -> T {
    use std::os::unix::io::AsRawFd;

    let stderr_fd = std::io::stderr().as_raw_fd();
    // 元の fd を dup で退避しておき、リダイレクト解除時に dup2 で復元する。
    let saved_fd = unsafe { libc::dup(stderr_fd) };
    if saved_fd < 0 {
        return f();
    }
    let Ok(devnull) = std::fs::OpenOptions::new().write(true).open("/dev/null") else {
        unsafe { libc::close(saved_fd) };
        return f();
    };
    let dup2_result = unsafe { libc::dup2(devnull.as_raw_fd(), stderr_fd) };
    if dup2_result < 0 {
        // リダイレクト自体に失敗した場合、退避したsaved_fdを閉じてそのままfを実行する
        // （抑制されないだけで、このヘルパー導入前と同じ挙動に劣化するだけなので実害は小さい）。
        unsafe { libc::close(saved_fd) };
        return f();
    }
    // ここから先は必ず _guard の Drop で復元される。f 内でのpanicを含め、途中で抜ける
    // 経路が増えても取りこぼさない（手続き的cleanupだった旧実装からのRAII化）。
    let _guard = StderrGuard {
        stderr_fd,
        saved_fd,
    };
    f()
}

#[cfg(not(unix))]
fn with_stderr_suppressed<T>(f: impl FnOnce() -> T) -> T {
    f()
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

    // ---- #559: stderr抑制ヘルパー（`with_stderr_suppressed`）----
    //
    // ALSA/JACK 由来のCレベルstderr出力を `OutputStream::try_default()` 呼び出し中だけ
    // 抑制するヘルパー（`with_stderr_suppressed` のdoc comment参照）。ここでは
    // クロージャの戻り値パススルー・fdリーク無し・実際の `AudioPlayer::try_new` 経路の
    // 3点を検証する。

    #[test]
    fn with_stderr_suppressed_returns_closure_value() {
        // 戻り値がクロージャの結果のまま透過することを確認する（正常系）。クロージャは
        // 即座に値を返すだけでI/Oしないため実行は一瞬で終わる。本テストは実際に
        // プロセスのfd2をdup/dup2/closeするので、他テストが同時にstderrへ書き込んで
        // いた場合そのメッセージが理論上一瞬だけ失われうるが、実行が一瞬なので許容する。
        assert_eq!(with_stderr_suppressed(|| 42), 42);
    }

    #[test]
    fn with_stderr_suppressed_preserves_non_trivial_return_types() {
        // ジェネリック`T`のパススルーが`i32`のような単純型に限らないことを、タプルと
        // `Option`（Some/None両方）という異なる形の型で確認する（同値分割）。
        assert_eq!(with_stderr_suppressed(|| (1, "a")), (1, "a"));
        assert_eq!(with_stderr_suppressed(|| Some(7)), Some(7));
        assert_eq!(with_stderr_suppressed(|| None::<i32>), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn with_stderr_suppressed_does_not_leak_fds_on_success() {
        // `/proc/self/fd` はLinux(procfs)限定の機構。`with_stderr_suppressed`内部の
        // dup(退避)→dup2(devnullへ差し替え)→f()→dup2(復元)→close(退避fdを閉じる)という
        // 一連の操作で、fdを1つもリークしないことを確認する（リソースリーク・正常系）。
        //
        // `cargo test`はデフォルトで並行実行されるため、他テストのファイルI/O等でfd数が
        // テスト実行中に多少変動しうる（フレーキー要因）。1回だけの前後差分ではノイズと
        // 本物のリークを区別しづらいため、10回連続呼び出しで増分を増幅させ、「1回あたり
        // 1個ずつ確実に漏れ続けた場合の増分(10)」よりも十分小さいことだけを確認する
        // （厳密な差分0を要求しない、ノイズ耐性のある比較方法）。
        let fd_count = || std::fs::read_dir("/proc/self/fd").unwrap().count();
        let before = fd_count();
        for _ in 0..10 {
            with_stderr_suppressed(|| {});
        }
        let after = fd_count();
        assert!(
            after <= before + 3,
            "fd leak suspected after 10 calls: before={before}, after={after}"
        );
    }

    #[test]
    fn with_stderr_suppressed_restores_stderr_even_when_f_panics() {
        // `f`がpanicしても`StderrGuard`の`Drop`が発火し、stderr(fd 2)が正しく復元される
        // ことを確認する（#559 セルフレビュー指摘のフォローアップ）。`catch_unwind`で
        // panicを外側に伝播させずに握りつぶし、その後`with_stderr_suppressed`をもう一度
        // 正常呼び出しして「壊れていない」ことを間接的に確認する。
        let result = std::panic::catch_unwind(|| {
            with_stderr_suppressed(|| {
                panic!("intentional panic to verify StderrGuard's Drop fires");
            })
        });
        assert!(result.is_err(), "panicがcatch_unwindで捕捉されているはず");

        // 復元されていることの確認: 再度`with_stderr_suppressed`を正常呼び出しし、
        // 戻り値が正しくパススルーされること（＝内部状態が壊れていないこと）を確認する。
        let value = with_stderr_suppressed(|| 123);
        assert_eq!(
            value, 123,
            "panic後もwith_stderr_suppressedが正常に機能し続けるはず"
        );
    }

    #[test]
    fn try_new_does_not_panic_regardless_of_audio_device_availability() {
        // 本節冒頭（#537）の通りCIには実オーディオデバイスが無いため`Some`が返ることは
        // 期待できないが、`try_new`自体を実際に呼び出すことで`with_stderr_suppressed`の
        // 「dup成功→devnullへのopen成功→f()実行→復元」という実経路を、
        // `OutputStream::try_default()`の実失敗込みで通す（状態遷移／実環境カバレッジ
        // としてはこのテストが唯一、#559回帰テストとして最も実利がある）。戻り値が
        // Some/Noneどちらであってもpanicしないことだけを見る（値はあえてアサートしない）。
        //
        // `with_stderr_suppressed`は`StderrGuard`によるRAII cleanupのため、`f`がpanicしても
        // スタックアンワインド中に`Drop`が呼ばれてstderrは復元される（#559セルフレビュー
        // 指摘対応。以前は手続き的cleanupで復元漏れの懸念があった）。
        let volume = VolumeConfig::default();
        let _ = AudioPlayer::try_new(&volume);
    }
}
