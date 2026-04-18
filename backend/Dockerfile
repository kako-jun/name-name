# syntax=docker/dockerfile:1.7
FROM python:3.11-slim

WORKDIR /app

# uv をインストール（公式バイナリ）
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# GitPython が使う git 本体
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

# 依存定義だけ先にコピーして依存レイヤをキャッシュ
COPY pyproject.toml uv.lock ./

# 仮想環境は /app/.venv（uv 既定）。本体コード同梱前に依存だけ同期
RUN uv sync --frozen --no-dev --no-install-project

# アプリコード
COPY app ./app

# プロジェクト自体もインストール
RUN uv sync --frozen --no-dev

# プロジェクトデータ格納先
RUN mkdir -p projects

# compose.yaml と統一
EXPOSE 7373

# uv 管理の venv 経由で uvicorn を起動
CMD ["uv", "run", "--no-dev", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7373"]
