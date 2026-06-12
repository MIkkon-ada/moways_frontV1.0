@echo off
cd /d D:\moways_ai\bowei_ai_dashboard
".venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 > server.out.log 2> server.err.log
