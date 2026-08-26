[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$stateDir = Join-Path $env:USERPROFILE ".local\state\m365-copilot-proxy"
$pidFile = Join-Path $stateDir "proxy.pid"
$watchdogPidFile = Join-Path $stateDir "watchdog.pid"
$stopFile = Join-Path $stateDir "watchdog.stop"

function Stop-TrackedProcess([string]$PidPath, [string]$Identity, [string]$Label) {
    if (-not (Test-Path -LiteralPath $PidPath)) { return $false }
    $raw = (Get-Content -LiteralPath $PidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
    $trackedPid = 0
    if (-not [int]::TryParse("$raw", [ref]$trackedPid)) {
        Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
        return $false
    }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$trackedPid" -ErrorAction SilentlyContinue
    if (-not $process) {
        Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
        return $false
    }
    $rootPattern = [Regex]::Escape($Root)
    if ($process.CommandLine -notmatch $rootPattern -or $process.CommandLine -notmatch $Identity) {
        Write-Warning "$Label PID $trackedPid no longer identifies this repository; leaving it untouched."
        Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
        return $false
    }
    Stop-Process -Id $trackedPid -ErrorAction SilentlyContinue
    Wait-Process -Id $trackedPid -Timeout 5 -ErrorAction SilentlyContinue
    if (Get-Process -Id $trackedPid -ErrorAction SilentlyContinue) { Stop-Process -Id $trackedPid -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    Write-Host "$Label stopped (PID $trackedPid)." -ForegroundColor Green
    return $true
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
New-Item -ItemType File -Force -Path $stopFile | Out-Null
$watchdogStopped = Stop-TrackedProcess $watchdogPidFile 'watch-proxy\.ps1' "Watchdog"
$proxyStopped = Stop-TrackedProcess $pidFile '(m365-proxy\.mjs|\.output[\\/]server[\\/]index\.mjs)' "Proxy"
Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue

if (-not $watchdogStopped -and -not $proxyStopped) {
    Write-Host "M365 proxy is not running (stale state cleaned)." -ForegroundColor Yellow
} else {
    Write-Host "M365 proxy is stopped. Claude Code and unrelated Node processes were not touched." -ForegroundColor Green
}
