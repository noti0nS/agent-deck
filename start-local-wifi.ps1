# Stop the existing collector first. Choose this PC's private IPv4 address.
param([Parameter(Mandatory = $true)][string]$LanAddress, [int]$Port = 4100)
$ErrorActionPreference = 'Stop'
$env:AGENT_DECK_LAN_HOST = $LanAddress
$env:AGENT_DECK_PORT = [string]$Port
Set-Location $PSScriptRoot
node apps/collector/dist/cli.js start
