@echo off
setlocal
cd /d %~dp0

if not exist .venv (
  py -3 -m venv .venv
)

call .venv\Scripts\activate
pip install -r requirements.txt

python migrate_sqlite_schema.py

set PORT=8000
rem 本项目固定使用 8000，避免误启动到其他端口
uvicorn app.main:app --host 0.0.0.0 --port %PORT%
