@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:4400
node --no-warnings server\index.mjs
