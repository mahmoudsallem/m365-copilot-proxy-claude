# m365-dsh launcher - DeepSeek Harness (Web UI) on the M365 proxy.
# Works from ANY directory. ASCII only (PS 5.1 BOM/ANSI lesson).
$ErrorActionPreference = 'Continue'

$repo = "E:\m365-copilot-proxy-claude"
$dshHome = "$env:USERPROFILE\.dsh-m365"

# 1. Ensure proxy is running.
$health = $null
try { $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4141/health" -TimeoutSec 3 } catch {}
if (-not $health) {
    Write-Host "[m365-dsh] proxy not responding - starting it..." -ForegroundColor Yellow
    Push-Location $repo
    & node scripts\start-daemon.mjs | Out-Null
    Pop-Location
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 700
        try { $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4141/health" -TimeoutSec 2; break } catch {}
    }
    if (-not $health) { Write-Host "[m365-dsh] proxy failed to start" -ForegroundColor Red; exit 1 }
}

# 2. dsh environment: home + provider key.
$env:DSH_HOME = $dshHome
$env:M365_PROXY_API_KEY = "m365"

Write-Host "[m365-dsh] starting DeepSeek Harness Web UI | provider=m365 -> http://127.0.0.1:4141/v1" -ForegroundColor Cyan
Write-Host "[m365-dsh] models: gpt-5.5 / claude-opus-5 / claude-sonnet-5 / sol" -ForegroundColor Gray
& "$env:LOCALAPPDATA\npm-global\dsh.cmd" --profile web $args
exit $LASTEXITCODE
