# Pure Windows PowerShell script to perform interactive Microsoft sign-in
$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot
Write-Host "Launching Microsoft interactive login..." -ForegroundColor Cyan
node scripts/auth-interactive.mjs
