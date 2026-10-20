# DSH Chrome Windows diagnostics collector (0.2.23)
# Usage: powershell -ExecutionPolicy Bypass -File .\windows-diagnostics.ps1
# Collects versions, manifest, registry, process list and the last 50 host.log lines.
# Never collects cookies, passwords, page bodies or bridge tokens.
$ErrorActionPreference = 'SilentlyContinue'
$out = Join-Path $env:USERPROFILE ("Desktop\dsh-chrome-diag-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $out | Out-Null

$info = [ordered]@{
  collectedAt = (Get-Date).ToString('o')
  computer = $env:COMPUTERNAME
  user = $env:USERNAME
  os = [Environment]::OSVersion.VersionString
  ps = $PSVersionTable.PSVersion.ToString()
}
$info | ConvertTo-Json | Set-Content (Join-Path $out 'system.json') -Encoding UTF8

$manifest = Join-Path $env:USERPROFILE '.dsh\cache\dsh-chrome\native-messaging-hosts\com.deepseek.dsh.chrome.json'
$manifestReport = [ordered]@{
  path = $manifest
  exists = (Test-Path $manifest)
  content = if (Test-Path $manifest) { Get-Content $manifest -Raw } else { $null }
  hostExe = Join-Path $env:USERPROFILE '.dsh\cache\dsh-chrome\host\dsh-chrome-host.exe'
  hostExeExists = (Test-Path (Join-Path $env:USERPROFILE '.dsh\cache\dsh-chrome\host\dsh-chrome-host.exe'))
}
$manifestReport | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $out 'manifest.json') -Encoding UTF8

reg query 'HKCU\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.dsh.chrome' /ve 2>&1 |
  Out-File (Join-Path $out 'registry.txt') -Encoding UTF8
reg query 'HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.deepseek.dsh.chrome' /ve 2>&1 |
  Out-File (Join-Path $out 'registry-edge.txt') -Encoding UTF8

Get-Process dsh-chrome-host,chrome,msedge -ErrorAction SilentlyContinue |
  Select-Object Name,Id,Path,WorkingSet64 |
  ConvertTo-Json | Set-Content (Join-Path $out 'processes.json') -Encoding UTF8

$hostLog = Join-Path $env:USERPROFILE '.dsh\cache\dsh-chrome\host.log'
if (Test-Path $hostLog) {
  Get-Content $hostLog -Tail 50 | Set-Content (Join-Path $out 'host.log.tail.txt') -Encoding UTF8
}

# Provider/bridge metadata only; never copy bridge.json (contains a token).
$bridge = Join-Path $env:USERPROFILE '.dsh\cache\dsh-chrome\bridge.json'
[ordered]@{ exists = (Test-Path $bridge); note = 'token intentionally not collected' } |
  ConvertTo-Json | Set-Content (Join-Path $out 'bridge.json.meta') -Encoding UTF8

$zip = "$out.zip"
Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip -Force
Write-Host "Diagnostics written to $zip"
Write-Host "Please review before sharing; do not include passwords/cookies/page bodies."
