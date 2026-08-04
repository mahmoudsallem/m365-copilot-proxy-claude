# M365 Copilot Proxy – PowerShell wrappers
# Converts Windows path to WSL /mnt/<drive>/... path and delegates to bash

function Get-WslPath($winPath) {
    $drive = $winPath.Substring(0,1).ToLower()
    $rest  = $winPath.Substring(2) -replace '\\', '/'
    "/mnt/$drive$rest"
}

$wslRoot = Get-WslPath $PSScriptRoot

function Start-M365Proxy  { & bash "$wslRoot/start-proxy.sh"  @args }
function Stop-M365Proxy   { & bash "$wslRoot/stop-proxy.sh"   @args }
function Get-M365Status   { & bash "$wslRoot/proxy-status.sh" @args }
function Connect-M365Claude { & bash "$wslRoot/connect-claude.sh" @args }

Export-ModuleMember -Function Start-M365Proxy, Stop-M365Proxy, Get-M365Status, Connect-M365Claude
