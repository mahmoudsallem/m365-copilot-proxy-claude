# m365-claude launcher - works from ANY directory.
# Usage:   m365-claude [claude args...]        (default model gpt-5.5)
#          m365-claude -Model claude-opus-5 [args...]
# NOTE: ASCII ONLY + saved with BOM. PS 5.1 reads BOM-less files as ANSI and
# smart-dashes inside strings corrupt parsing (learned the hard way).
$ErrorActionPreference = 'Continue'

$repo = "E:\m365-copilot-proxy-claude"
$model = "gpt-5.5"
if ($args.Count -ge 2 -and $args[0] -ieq "-Model") {
    $model = $args[1]
    if ($args.Count -gt 2) { $args = $args[2..($args.Count - 1)] } else { $args = @() }
}

# 1. Ensure the proxy is running (start it if not).
$health = $null
try { $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4141/health" -TimeoutSec 3 } catch {}
if (-not $health) {
    Write-Host "[m365-claude] proxy not responding - starting it..." -ForegroundColor Yellow
    Push-Location $repo
    & node scripts\start-daemon.mjs | Out-Null
    Pop-Location
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 700
        try { $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4141/health" -TimeoutSec 2; break } catch {}
    }
    if (-not $health) {
        Write-Host "[m365-claude] proxy failed to start - see %USERPROFILE%\.local\state\m365-copilot-proxy\proxy.log" -ForegroundColor Red
        exit 1
    }
}

# 2. Wire Anthropic env to the proxy.
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:4141"
$keyLine = Get-Content "$env:USERPROFILE\.config\m365-copilot-proxy\proxy.env" -ErrorAction SilentlyContinue |
    Where-Object { $_ -match '^M365_PROXY_API_KEY=' } | Select-Object -First 1
$env:ANTHROPIC_AUTH_TOKEN = if ($keyLine) { ($keyLine -replace '^M365_PROXY_API_KEY=', '').Trim('"') } else { "m365" }
Remove-Item Env:\ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"

Write-Host "[m365-claude] connected | model=$model | dashboard=http://127.0.0.1:4141/" -ForegroundColor Cyan
& "$env:LOCALAPPDATA\npm-global\claude.cmd" --model $model --dangerously-skip-permissions @args
exit $LASTEXITCODE
