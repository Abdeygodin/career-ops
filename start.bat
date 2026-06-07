@echo off
chcp 65001 >nul
title career-ops

echo.
echo  ⚡ career-ops — запуск...
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ❌ Node.js не найден.
    echo     Скачай и установи: https://nodejs.org  ^(версия 20+^)
    echo.
    pause
    exit /b 1
)

:: Check Ollama (optional — OpenRouter / Claude API also work)
where ollama >nul 2>&1
if %errorlevel% neq 0 (
    echo  ℹ️  Ollama не найдена. Это нормально если используешь OpenRouter или Claude API.
    echo     Настрой провайдера в приложении: Настройки -^> ИИ
    echo.
)

:: Install deps if needed
if not exist "node_modules" (
    echo  📦 Первый запуск — устанавливаю зависимости...
    call npm install --prefer-offline 2>&1
    if %errorlevel% neq 0 (
        echo  ❌ npm install завершился с ошибкой.
        pause
        exit /b 1
    )
)

:: Install Playwright browsers if needed
if not exist "node_modules\playwright\.local-browsers" (
    echo  🌐 Устанавливаю Chromium для Playwright...
    call npx playwright install chromium 2>&1
)

:: Create .env from example if missing
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo  📝 Создан .env из примера — настрой при необходимости.
    )
)

:: Open browser after 2 seconds
echo.
echo  🌐 Открываю браузер на http://localhost:3000
echo  ✋ Закрой это окно чтобы остановить сервер.
echo.
start "" /b cmd /c "timeout /t 2 >nul && start http://localhost:3000"

:: Start server
node web/server.mjs

pause
