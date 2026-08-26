# watchdog: keeps the m365 proxy alive. Spawned detached by run.ps1.
# Loop: if /health is down -> respawn the built server. Exits when the
# stop-file appears (run.ps1 creates it on -StopProxy / shutdown).
param(
    [Parameter(Mandatory)] [string]$Root,
    [Parameter(Mandatory)] [int]$Port,
    [string]$StateDir = "",
    [string]$StopFile = ""
)
$serverScript = Join-Path $Root "packages/proxy/bin/m365-proxy.mjs"
if (-not $StateDir) { $StateDir = $Root }
if (-not $StopFile) { $StopFile = Join-Path $Root ".proxy-watchdog-stop" }
$pidFile = Join-Path $StateDir "proxy.pid"
$stdinFile = Join-Path $StateDir "stdin.empty"
if (-not (Test-Path -LiteralPath $stdinFile)) { New-Item -ItemType File -Path $stdinFile | Out-Null }
$url = "http://127.0.0.1:$Port/health"
$isWin = ($env:OS -eq "Windows_NT")
$restartTimes = @()
$consecutiveFailures = 0

while ($true) {
    if (Test-Path $StopFile) {
        break
    }

    $up = $false
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri $url `
            -Headers @{ Authorization = "Bearer m365" } -TimeoutSec 3 -ErrorAction Stop
        $up = ($resp.StatusCode -eq 200)
    } catch { $up = $false }

    if (-not $up) {
        $now = Get-Date
        $restartTimes = @($restartTimes | Where-Object { ($now - $_).TotalMinutes -lt 10 })
        if ($restartTimes.Count -ge 5) {
            Write-Warning "watchdog: restart limit reached (5 restarts in 10 minutes); stopping to avoid a crash loop"
            break
        }
        $consecutiveFailures++
        $delay = [Math]::Min(60, [Math]::Pow(2, [Math]::Min(5, $consecutiveFailures - 1)))
        Start-Sleep -Seconds $delay
        if (Test-Path $StopFile) { break }
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $sp = @{
            FilePath               = "node"
            ArgumentList           = @("`"$serverScript`"")
            WorkingDirectory       = $Root
            PassThru               = $true
            RedirectStandardOutput = (Join-Path $StateDir "proxy.$stamp.log")
            RedirectStandardError  = (Join-Path $StateDir "proxy.$stamp.err.log")
        }
        if ($isWin) { $sp.WindowStyle = "Hidden"; $sp.RedirectStandardInput = $stdinFile }
        try {
            $proc = Start-Process @sp
            if (-not $proc) { Write-Warning "watchdog: Start-Process returned null" }
            else {
                Set-Content -LiteralPath $pidFile -Value $proc.Id -Encoding ASCII
                $restartTimes += $now
            }
        } catch {
            Write-Warning "watchdog: respawn failed: $($_.Exception.Message)"
        }
    } else {
        $consecutiveFailures = 0
    }
    Start-Sleep -Seconds 5
}
