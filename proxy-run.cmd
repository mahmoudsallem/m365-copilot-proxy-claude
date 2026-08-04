@echo off
setlocal

set "M365_PROXY_API_KEY=m365"
set "M365_SKIP_STARTUP_AUTH=1"
set "M365_REQUIRE_API_KEY=1"
set "HOST=127.0.0.1"
set "NITRO_HOST=127.0.0.1"
set "PORT=4141"

set "PROXY_SCRIPT=%~dp0packages\proxy\bin\m365-proxy.mjs"
set "LOG_FILE=%USERPROFILE%\.local\state\m365-copilot-proxy\proxy.log"

node "%PROXY_SCRIPT%" 4141 > "%LOG_FILE%" 2>&1
