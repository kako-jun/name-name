from pydantic import BaseModel
from typing import List


class Cut(BaseModel):
    """カット（台詞の最小単位）"""
    id: int
    character: str
    text: str
    expression: str


class Scene(BaseModel):
    """シーン"""
    id: int
    title: str
    cuts: List[Cut]


class Chapter(BaseModel):
    """章"""
    id: int
    title: str
    scenes: List[Scene]


class ChaptersRequest(BaseModel):
    """章リスト更新リクエスト"""
    chapters: List[Chapter]
    message: str = "原稿更新"


class ChaptersResponse(BaseModel):
    """章リスト取得レスポンス"""
    chapters: List[Chapter]


class SaveResponse(BaseModel):
    """保存レスポンス"""
    success: bool
    commit_hash: str | None = None
    error: str | None = None
