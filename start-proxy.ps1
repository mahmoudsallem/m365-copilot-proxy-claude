# Pure Windows PowerShell script to start M365 Copilot Proxy natively
$ErrorActionPreference = 'Stop'

$configDir = Join-Path $env:USERPROFILE ".config\m365-copilot-proxy"
$stateDir  = Join-Path $env:USERPROFILE ".local\state\m365-copilot-proxy"
$envFile   = Join-Path $configDir "proxy.env"
$pidFile   = Join-Path $stateDir "proxy.pid"
$logFile   = Join-Path $stateDir "proxy.log"
$errFile   = Join-Path $stateDir "proxy.err.log"

New-Item -ItemType Directory -Force -Path $configDir, $stateDir | Out-Null

if (-not (Test-Path $envFile)) {
    @"
M365_PROXY_API_KEY=m365
M365_REQUIRE_API_KEY=1
M365_INTERACTIVE_LOGIN=1
HOST=127.0.0.1
NITRO_HOST=127.0.0.1
PORT=4141
M365_SKIP_STARTUP_AUTH=1
"@ | Set-Content -Path $envFile -Encoding UTF8
    Write-Host "Created proxy configuration at $envFile" -ForegroundColor Cyan
}

$port = "4141"
$apiUrl = "http://127.0.0.1:$port"

# Check if already healthy
$out = curl.exe -s "$apiUrl/health" 2>$null
if ($out -match '"status"\s*:\s*"ok"') {
    Write-Host "Proxy is already running and healthy at $apiUrl" -ForegroundColor Green
    exit 0
}

$proxyScript = Join-Path $PSScriptRoot "packages\proxy\bin\m365-proxy.mjs"
$daemonScript = Join-Path $PSScriptRoot "scripts\start-daemon.mjs"

# Kill old process if running
$oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($oldPid) {
    try { Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Milliseconds 500
}

# Set env vars for the daemon launcher
$env:M365_PROXY_API_KEY = "m365"
$env:M365_REQUIRE_API_KEY = "1"
$env:HOST = "127.0.0.1"
$env:NITRO_HOST = "127.0.0.1"
$env:PORT = $port

# Use the Node daemon script which handles its own file I/O (no pipe-to-file crash)
node "$daemonScript"

# Poll for health (up to 10 seconds)
$started = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $out = curl.exe -s "$apiUrl/health" 2>$null
    if ($out -match '"status"\s*:\s*"ok"') {
        $started = $true
        break
    }
}

$runningPid = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($started) {
    Write-Host "Proxy is RUNNING and HEALTHY at: $apiUrl (PID $runningPid)" -ForegroundColor Green
    Write-Host "API Key: m365" -ForegroundColor Cyan
} else {
    Write-Host "Proxy started (PID $runningPid). Waiting for auth to complete..." -ForegroundColor Yellow
}
Write-Host "Log file: $logFile" -ForegroundColor Gray
