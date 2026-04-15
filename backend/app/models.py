from pydantic import BaseModel
from typing import List


class Scene(BaseModel):
    """シーン"""
    id: int
    title: str


class Chapter(BaseModel):
    """章"""
    id: int
    title: str
    scenes: List[Scene]


class MarkdownContentRequest(BaseModel):
    """Markdown生テキスト更新リクエスト"""
    content: str
    message: str = "原稿更新"


class MarkdownContentResponse(BaseModel):
    """Markdown生テキスト取得レスポンス"""
    content: str


class SaveResponse(BaseModel):
    """保存レスポンス"""
    success: bool
    commit_hash: str | None = None
    error: str | None = None
