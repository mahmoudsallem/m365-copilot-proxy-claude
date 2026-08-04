# Pure Windows PowerShell script for Microsoft device-code sign-in
$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot
Write-Host "Launching Microsoft device-code login..." -ForegroundColor Cyan
node scripts/auth-device.mjs
