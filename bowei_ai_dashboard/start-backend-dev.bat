@echo off
setlocal
cd /d %~dp0

if not exist .venv (
  echo 正在初始化 Python 环境...
  py -3 -m venv .venv
  call .venv\Scripts\activate
  pip install -r requirements.txt
) else (
  call .venv\Scripts\activate
)

echo 后端启动中... http://127.0.0.1:8002
.venv\Scripts\uvicorn.exe app.main:app --reload --host 0.0.0.0 --port 8002

endlocal
