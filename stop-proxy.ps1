# Pure Windows PowerShell script to stop M365 Copilot Proxy
$stateDir = Join-Path $env:USERPROFILE ".local\state\m365-copilot-proxy"
$pidFile  = Join-Path $stateDir "proxy.pid"

$stopped = $false

if (Test-Path $pidFile) {
    $procId = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($procId) {
        try {
            Stop-Process -Id $procId -Force -ErrorAction Stop
            Write-Host "Proxy process (PID $procId) stopped." -ForegroundColor Green
            $stopped = $true
        } catch {}
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

if (-not $stopped) {
    $procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*m365-proxy.mjs*" }
    if ($procs) {
        foreach ($p in $procs) {
            Stop-Process -Id $p.ProcessId -Force
            Write-Host "Stopped m365-proxy process (PID $($p.ProcessId))." -ForegroundColor Green
            $stopped = $true
        }
    }
}

if (-not $stopped) {
    Write-Host "Proxy is not running." -ForegroundColor Yellow
}
