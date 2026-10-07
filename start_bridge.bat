@echo off
chcp 65001 > nul
title Chess Sensei - Native Stockfish Bridge Server
echo ============================================================
echo   🚀 CHESS SENSEI - ЛОКАЛЬНЫЙ МОСТ STOCKFISH
echo ============================================================
echo.

where python >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Python не найден в системе!
    echo Пожалуйста, установите Python: https://www.python.org/
    echo.
    pause
    exit /b 1
)

echo [INFO] Запуск локального сервера моста на http://127.0.0.1:5000 ...
echo [INFO] Сервер подключен к официальному Stockfish на вашем компьютере.
echo.
python "%~dp0bridge\local_server.py"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ОШИБКА] Сервер завершил работу с кодом ошибки.
    pause
)
