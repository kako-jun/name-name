from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pathlib import Path
import logging
import shutil
import json
from typing import List, Optional

from .models import (
    Chapter,
    ChaptersRequest,
    ChaptersResponse,
    SaveResponse,
)
from .git_service import GitService
from .markdown_parser import chapters_to_markdown, markdown_to_chapters

# ログ設定
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Name×Name API",
    description="ビジュアルノベル原稿管理API",
    version="0.1.0",
)

# CORS設定
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 開発中はすべて許可
    allow_credentials=False,  # *を使う場合はFalseにする必要がある
    allow_methods=["*"],
    allow_headers=["*"],
)

# プロジェクト管理用ディレクトリ
PROJECTS_DIR = Path("./projects")
PROJECTS_DIR.mkdir(exist_ok=True)

# プロジェクトごとのGitService管理
git_services: dict[str, GitService] = {}


def get_project_config_path(project_name: str) -> Path:
    """プロジェクト設定ファイルのパスを取得"""
    return PROJECTS_DIR / project_name / ".name-name.json"


def load_project_config(project_name: str) -> dict:
    """プロジェクト設定を読み込み"""
    config_path = get_project_config_path(project_name)
    if config_path.exists():
        return json.loads(config_path.read_text(encoding="utf-8"))
    return {"branch": "develop"}  # デフォルトはdevelopブランチ


def save_project_config(project_name: str, config: dict):
    """プロジェクト設定を保存"""
    config_path = get_project_config_path(project_name)
    config_path.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")


def get_git_service(project_name: str) -> GitService:
    """プロジェクトのGitServiceを取得"""
    if project_name not in git_services:
        project_path = PROJECTS_DIR / project_name
        config = load_project_config(project_name)
        branch = config.get("branch", "develop")
        git_services[project_name] = GitService(str(project_path), branch=branch)
    return git_services[project_name]


def get_chapters_file_path(project_name: str) -> Path:
    """章データファイルのパスを取得"""
    return PROJECTS_DIR / project_name / "chapters" / "all.md"


def get_assets_dir(project_name: str, asset_type: str) -> Path:
    """アセットディレクトリのパスを取得"""
    return PROJECTS_DIR / project_name / "assets" / asset_type


def get_project_path(project_name: str) -> Path:
    """プロジェクトのルートパスを取得"""
    return PROJECTS_DIR / project_name


@app.get("/")
async def root():
    """ヘルスチェック"""
    return {"status": "ok", "message": "Name×Name API is running"}


@app.get("/api/projects")
async def list_projects():
    """プロジェクト一覧を取得"""
    projects = []
    if PROJECTS_DIR.exists():
        for item in PROJECTS_DIR.iterdir():
            if item.is_dir() and (item / ".git").exists():
                config = load_project_config(item.name)
                projects.append({
                    "name": item.name,
                    "path": str(item),
                    "branch": config.get("branch", "develop"),
                })
    return {"projects": projects}


@app.post("/api/projects/clone")
async def clone_project(body: dict):
    """プロジェクトをクローン"""
    project_name = body.get("name")
    repo_url = body.get("repo_url")
    branch = body.get("branch", "develop")  # デフォルトはdevelop

    if not project_name or not repo_url:
        raise HTTPException(status_code=400, detail="name and repo_url are required")

    project_path = PROJECTS_DIR / project_name

    if project_path.exists():
        raise HTTPException(status_code=400, detail=f"Project '{project_name}' already exists")

    try:
        # まずGitリポジトリをクローン
        # GitServiceを作成（ブランチ指定）
        git_services[project_name] = GitService(str(project_path), branch=branch)
        git_service = git_services[project_name]
        git_service.init_or_clone(repo_url)

        # クローン成功後に設定を保存
        save_project_config(project_name, {"branch": branch})

        return {
            "success": True,
            "message": f"Project '{project_name}' cloned successfully",
            "branch": branch
        }
    except Exception as e:
        logger.error(f"Clone failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/projects/init")
async def init_project(body: dict):
    """新規プロジェクトを初期化（Gitリポジトリ作成）"""
    project_name = body.get("name")
    branch = body.get("branch", "develop")  # デフォルトはdevelop

    if not project_name:
        raise HTTPException(status_code=400, detail="name is required")

    project_path = PROJECTS_DIR / project_name

    if project_path.exists():
        raise HTTPException(status_code=400, detail=f"Project '{project_name}' already exists")

    try:
        # プロジェクトディレクトリを作成
        project_path.mkdir(parents=True, exist_ok=True)

        # 設定を保存
        save_project_config(project_name, {"branch": branch})

        git_service = get_git_service(project_name)
        git_service.init_or_clone()  # ローカルリポジトリ初期化

        # 初期ディレクトリ構造を作成
        chapters_dir = project_path / "chapters"
        chapters_dir.mkdir(parents=True, exist_ok=True)

        # アセットディレクトリを作成
        for asset_type in ["images", "sounds", "movies", "ideas"]:
            asset_dir = project_path / "assets" / asset_type
            asset_dir.mkdir(parents=True, exist_ok=True)
            # .gitkeepを作成して空ディレクトリをGit管理
            (asset_dir / ".gitkeep").touch()

        # 空の章ファイルを作成
        initial_content = "# プロジェクト: {}\n\n".format(project_name)
        (chapters_dir / "all.md").write_text(initial_content, encoding="utf-8")

        # .gitignoreを作成（ローカル設定ファイルを除外）
        gitignore_content = "# Name×Name local config\n.name-name.json\n"
        (project_path / ".gitignore").write_text(gitignore_content, encoding="utf-8")

        return {
            "success": True,
            "message": f"Project '{project_name}' initialized",
            "branch": branch
        }
    except Exception as e:
        logger.error(f"Init failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/projects/{project_name}/chapters", response_model=ChaptersResponse)
async def get_chapters(project_name: str):
    """指定プロジェクトの章データを取得（ワーキングディレクトリから、未コミットの変更含む）"""
    file_path = get_chapters_file_path(project_name)

    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"Chapters file not found: {file_path}")

    # ワーキングディレクトリから直接読み込み（pullしない）
    markdown_content = file_path.read_text(encoding="utf-8")
    chapters = markdown_to_chapters(markdown_content)

    return ChaptersResponse(chapters=chapters)


@app.put("/api/projects/{project_name}/chapters")
async def update_chapters(project_name: str, body: ChaptersRequest):
    """指定プロジェクトの章データをワーキングディレクトリに書き込む（コミットはしない）"""
    file_path = get_chapters_file_path(project_name)

    # 親ディレクトリを作成
    file_path.parent.mkdir(parents=True, exist_ok=True)

    # ChaptersをMarkdownに変換
    markdown_content = chapters_to_markdown(body.chapters)

    # ファイルに書き込み（コミットはしない）
    file_path.write_text(markdown_content, encoding="utf-8")

    return {
        "success": True,
        "message": "ワーキングディレクトリに保存しました（未コミット）"
    }


@app.post("/api/projects/{project_name}/commit", response_model=SaveResponse)
async def commit_changes(project_name: str, body: dict):
    """ワーキングディレクトリの変更をコミット・プッシュ"""
    git_service = get_git_service(project_name)
    message = body.get("message", "原稿更新")

    # すべての変更をコミット
    commit_hash = git_service.commit_and_push(".", message)

    return SaveResponse(success=True, commit_hash=commit_hash)


@app.get("/api/projects/{project_name}/status")
async def get_project_status(project_name: str):
    """プロジェクトの状態を取得（未コミットの変更があるか）"""
    git_service = get_git_service(project_name)

    has_changes = git_service.has_changes()

    return {
        "has_uncommitted_changes": has_changes,
        "message": "未コミットの変更があります" if has_changes else "すべてコミット済み"
    }


@app.post("/api/projects/{project_name}/discard")
async def discard_changes(project_name: str):
    """未コミットの変更を破棄（git checkout . + 未追跡ファイル削除）"""
    git_service = get_git_service(project_name)

    try:
        success = git_service.discard_changes()
        if not success:
            raise HTTPException(status_code=500, detail="Failed to discard changes")

        return {
            "success": True,
            "message": "すべての変更を破棄しました"
        }
    except Exception as e:
        logger.error(f"Discard failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/projects/{project_name}/sync")
async def sync_project(project_name: str):
    """プロジェクトを同期（git pull）"""
    git_service = get_git_service(project_name)

    try:
        success = git_service.pull()
        has_changes = git_service.has_changes()

        return {
            "success": success,
            "has_changes": has_changes,
            "message": "Synced successfully" if success else "No remote configured",
        }
    except Exception as e:
        logger.error(f"Sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/projects/{project_name}/switch-branch")
async def switch_branch(project_name: str, body: dict):
    """ブランチを切り替え

    開発環境で本番ブランチ(main)を確認したり、
    本番ブランチから開発ブランチ(develop)に戻したりする
    """
    new_branch = body.get("branch")

    if not new_branch:
        raise HTTPException(status_code=400, detail="branch is required")

    project_path = get_project_path(project_name)
    if not project_path.exists():
        raise HTTPException(status_code=404, detail=f"Project '{project_name}' not found")

    try:
        # 設定を更新
        config = load_project_config(project_name)
        config["branch"] = new_branch
        save_project_config(project_name, config)

        # GitServiceのキャッシュをクリア
        if project_name in git_services:
            del git_services[project_name]

        # 新しいブランチで再初期化
        git_service = get_git_service(project_name)
        git_service.init_or_clone()

        return {
            "success": True,
            "branch": new_branch,
            "message": f"Switched to branch '{new_branch}'",
        }
    except Exception as e:
        logger.error(f"Switch branch failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# === アセット管理エンドポイント ===


@app.get("/api/projects/{project_name}/assets/{asset_type}")
async def list_assets(project_name: str, asset_type: str):
    """指定タイプのアセット一覧を取得

    asset_type: images, sounds, movies, ideas
    """
    if asset_type not in ["images", "sounds", "movies", "ideas"]:
        raise HTTPException(status_code=400, detail="asset_type must be images, sounds, movies, or ideas")

    project_path = get_project_path(project_name)
    if not project_path.exists():
        raise HTTPException(status_code=404, detail=f"Project '{project_name}' not found")

    assets_dir = get_assets_dir(project_name, asset_type)

    if not assets_dir.exists():
        return {"assets": []}

    assets = []
    for file_path in assets_dir.iterdir():
        if file_path.is_file() and file_path.name != ".gitkeep":
            assets.append({
                "name": file_path.name,
                "size": file_path.stat().st_size,
                "url": f"/api/projects/{project_name}/assets/{asset_type}/{file_path.name}",
            })

    return {"assets": assets}


@app.post("/api/projects/{project_name}/assets/{asset_type}")
async def upload_asset(
    project_name: str,
    asset_type: str,
    file: UploadFile = File(...),
    commit_message: str = None,
):
    """アセットをアップロード

    asset_type: images, sounds, movies, ideas
    """
    if asset_type not in ["images", "sounds", "movies", "ideas"]:
        raise HTTPException(status_code=400, detail="asset_type must be images, sounds, movies, or ideas")

    project_path = get_project_path(project_name)
    if not project_path.exists():
        raise HTTPException(status_code=404, detail=f"Project '{project_name}' not found")

    try:
        # アセットディレクトリを作成
        assets_dir = get_assets_dir(project_name, asset_type)
        assets_dir.mkdir(parents=True, exist_ok=True)

        # ファイルを保存（コミットはしない）
        file_path = assets_dir / file.filename
        with file_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        return {
            "success": True,
            "filename": file.filename,
            "url": f"/api/projects/{project_name}/assets/{asset_type}/{file.filename}",
            "message": "ワーキングディレクトリに保存しました（未コミット）",
        }
    except Exception as e:
        logger.error(f"Upload asset failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/projects/{project_name}/assets/{asset_type}/{filename}")
async def get_asset(project_name: str, asset_type: str, filename: str):
    """アセットファイルを取得（配信）

    asset_type: images, sounds, movies, ideas
    """
    if asset_type not in ["images", "sounds", "movies", "ideas"]:
        raise HTTPException(status_code=400, detail="asset_type must be images, sounds, movies, or ideas")

    assets_dir = get_assets_dir(project_name, asset_type)
    file_path = assets_dir / filename

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")

    return FileResponse(file_path)


@app.delete("/api/projects/{project_name}/assets/{asset_type}/{filename}")
async def delete_asset(
    project_name: str,
    asset_type: str,
    filename: str,
    commit_message: str = None,
):
    """アセットを削除

    asset_type: images, sounds, movies, ideas
    """
    if asset_type not in ["images", "sounds", "movies", "ideas"]:
        raise HTTPException(status_code=400, detail="asset_type must be images, sounds, movies, or ideas")

    project_path = get_project_path(project_name)
    if not project_path.exists():
        raise HTTPException(status_code=404, detail=f"Project '{project_name}' not found")

    assets_dir = get_assets_dir(project_name, asset_type)
    file_path = assets_dir / filename

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Asset not found")

    try:
        # ファイルを削除（コミットはしない）
        file_path.unlink()

        return {
            "success": True,
            "filename": filename,
            "message": "ワーキングディレクトリから削除しました（未コミット）",
        }
    except Exception as e:
        logger.error(f"Delete asset failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
