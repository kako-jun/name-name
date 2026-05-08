import { useState } from 'react'

/**
 * タイトル画面オーバーレイ (#141)
 *
 * ゲーム開始前に表示するタイトル画面。
 * - タイトル画像（assets/title.png）があれば表示、なければタイトルテキスト
 * - ボタン: 新規開始 / つづきから / 設定 / 終了
 * - 「つづきから」は hasSaveData=true の場合のみ有効
 */

interface TitleOverlayProps {
  /** ゲームのタイトル文字列（title.png がない場合に表示） */
  title: string
  /** タイトル画像の URL（assets/title.png など）。読み込み失敗時はタイトルテキストで代替 */
  titleImageUrl?: string
  /** 既読データが存在するか（「つづきから」ボタンの有効/無効制御） */
  hasSaveData: boolean
  /** 「新規開始」ボタン押下時 */
  onNewGame: () => void
  /** 「つづきから」ボタン押下時 */
  onContinue: () => void
  /** 「設定」ボタン押下時 */
  onOpenSettings: () => void
  /** 「終了」ボタン押下時（プロジェクト一覧に戻る） */
  onBack: () => void
  /** ダークモード */
  isDark?: boolean
}

function TitleOverlay({
  title,
  titleImageUrl,
  hasSaveData,
  onNewGame,
  onContinue,
  onOpenSettings,
  onBack,
  isDark = false,
}: TitleOverlayProps) {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)

  const showImage = titleImageUrl && !imageFailed

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center z-50"
      style={{ background: isDark ? '#111827' : '#1e1b4b' }}
    >
      {/* タイトル */}
      <div className="mb-10 flex flex-col items-center">
        {showImage && (
          <img
            src={titleImageUrl}
            alt={title}
            onLoad={() => setImageLoaded(true)}
            onError={() => setImageFailed(true)}
            className={`max-w-xs max-h-40 object-contain transition-opacity duration-300 ${
              imageLoaded ? 'opacity-100' : 'opacity-0'
            }`}
          />
        )}
        {/* 画像がない・失敗・読み込み前はテキストを表示 */}
        {(!showImage || !imageLoaded) && (
          <h1
            className="text-4xl font-bold tracking-widest text-white"
            style={{ textShadow: '0 2px 12px rgba(0,0,0,0.6)' }}
          >
            {title}
          </h1>
        )}
      </div>

      {/* ボタン群 */}
      <div className="flex flex-col gap-3 w-48">
        <TitleButton onClick={onNewGame}>新規開始</TitleButton>
        <TitleButton onClick={onContinue} disabled={!hasSaveData}>
          つづきから
        </TitleButton>
        <TitleButton onClick={onOpenSettings} variant="secondary">
          設定
        </TitleButton>
        <TitleButton onClick={onBack} variant="secondary">
          終了
        </TitleButton>
      </div>
    </div>
  )
}

interface TitleButtonProps {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'secondary'
}

function TitleButton({
  children,
  onClick,
  disabled = false,
  variant = 'primary',
}: TitleButtonProps) {
  const base =
    'w-full py-2.5 px-4 rounded text-sm font-semibold tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-indigo-950'

  const variants = {
    primary: disabled
      ? 'bg-indigo-900 text-indigo-400 cursor-not-allowed'
      : 'bg-indigo-600 hover:bg-indigo-500 text-white focus:ring-indigo-400',
    secondary: disabled
      ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
      : 'bg-gray-700 hover:bg-gray-600 text-gray-200 focus:ring-gray-400',
  }

  return (
    <button className={`${base} ${variants[variant]}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

export default TitleOverlay
