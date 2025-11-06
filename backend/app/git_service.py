import os
from pathlib import Path
from git import Repo, GitCommandError
from typing import Optional
import logging

logger = logging.getLogger(__name__)


class GitService:
    """Git操作を管理するサービス"""

    def __init__(self, repo_path: str = "./repo", branch: str = "develop"):
        self.repo_path = Path(repo_path)
        self.repo: Optional[Repo] = None
        self.branch = branch

    def init_or_clone(self, remote_url: Optional[str] = None):
        """リポジトリを初期化またはクローン"""
        if self.repo_path.exists() and (self.repo_path / ".git").exists():
            logger.info(f"既存のリポジトリを使用: {self.repo_path}")
            self.repo = Repo(self.repo_path)
            self._checkout_branch()
        elif remote_url:
            logger.info(f"リポジトリをクローン: {remote_url}")
            self.repo = Repo.clone_from(remote_url, self.repo_path)
            self._checkout_branch()
        else:
            logger.info(f"新規リポジトリを初期化: {self.repo_path}")
            self.repo_path.mkdir(parents=True, exist_ok=True)
            self.repo = Repo.init(self.repo_path)
            # 初期コミットを作成してからブランチを作成
            self._create_initial_commit()
            self._checkout_branch()

    def _create_initial_commit(self):
        """初期コミットを作成（空のリポジトリ用）"""
        if self.repo and not self.repo.heads:
            # .gitkeepを作成して初期コミット
            gitkeep = self.repo_path / ".gitkeep"
            gitkeep.touch()
            self.repo.index.add([".gitkeep"])
            self.repo.index.commit("Initial commit")
            logger.info("初期コミットを作成")

    def _checkout_branch(self):
        """指定されたブランチにチェックアウト"""
        if not self.repo:
            return

        try:
            # ブランチが存在するか確認
            if self.branch in self.repo.heads:
                # ローカルブランチが存在する
                self.repo.heads[self.branch].checkout()
                logger.info(f"ブランチ '{self.branch}' にチェックアウト")
            elif self.repo.remotes and f"origin/{self.branch}" in [str(ref) for ref in self.repo.remotes.origin.refs]:
                # リモートブランチが存在する
                self.repo.create_head(self.branch, f"origin/{self.branch}")
                self.repo.heads[self.branch].checkout()
                logger.info(f"リモートブランチ '{self.branch}' からローカルブランチを作成")
            else:
                # ブランチが存在しない場合は作成
                if self.repo.heads:  # HEADが存在する場合のみ
                    self.repo.create_head(self.branch)
                    self.repo.heads[self.branch].checkout()
                    logger.info(f"新しいブランチ '{self.branch}' を作成")
        except Exception as e:
            logger.error(f"ブランチチェックアウト失敗: {e}")
            raise

    def pull(self) -> bool:
        """最新の変更を取得"""
        try:
            if self.repo and self.repo.remotes:
                origin = self.repo.remotes.origin
                # 現在のブランチをpull
                origin.pull(self.branch)
                logger.info(f"git pull 成功 (ブランチ: {self.branch})")
                return True
        except GitCommandError as e:
            logger.error(f"git pull 失敗: {e}")
        return False

    def commit_and_push(self, file_path: str, message: str) -> Optional[str]:
        """ファイルをコミットしてプッシュ"""
        try:
            if not self.repo:
                raise ValueError("リポジトリが初期化されていません")

            # ファイルをステージング
            self.repo.index.add([file_path])

            # コミット
            commit = self.repo.index.commit(message)
            commit_hash = commit.hexsha[:7]
            logger.info(f"コミット成功: {commit_hash} (ブランチ: {self.branch})")

            # プッシュ（リモートがある場合）
            if self.repo.remotes:
                origin = self.repo.remotes.origin
                # 現在のブランチをpush（初回はupstreamを設定）
                origin.push(refspec=f"{self.branch}:{self.branch}", set_upstream=True)
                logger.info(f"git push 成功 (ブランチ: {self.branch})")

            return commit_hash
        except GitCommandError as e:
            logger.error(f"git commit/push 失敗: {e}")
            return None

    def get_repo_path(self) -> Path:
        """リポジトリのパスを取得"""
        return self.repo_path

    def has_changes(self) -> bool:
        """未コミットの変更があるか"""
        if not self.repo:
            return False
        return self.repo.is_dirty() or len(self.repo.untracked_files) > 0
