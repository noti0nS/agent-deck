# Stop the existing collector first. Update the address if DHCP changes it.
$env:AGENT_DECK_LAN_HOST = '192.168.0.3'
$env:AGENT_DECK_SERVE_HTTPS_PORT = '8444'
Set-Location $PSScriptRoot
node apps/collector/dist/cli.js start
