from pydantic import BaseModel


class MarkdownContentRequest(BaseModel):
    """Markdown生テキスト更新リクエスト"""
    content: str


class MarkdownContentResponse(BaseModel):
    """Markdown生テキスト取得レスポンス"""
    content: str


class SaveResponse(BaseModel):
    """保存レスポンス"""
    success: bool
    commit_hash: str | None = None
    error: str | None = None
