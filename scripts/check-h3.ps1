# 检查 H3 工作台是否可连接（地址取自 data/local-ai.json）
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$cfgPath = Join-Path $root "data\local-ai.json"
$base = "http://127.0.0.1:7860"

if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.h3BaseUrl) { $base = ($cfg.h3BaseUrl -replace "/+$", "") }
  } catch { }
}

Write-Output ("  检测地址: " + $base)

try {
  $u = [System.Uri]$base
  $port = 80
  if ($u.Port -gt 0) { $port = $u.Port } elseif ($u.Scheme -eq "https") { $port = 443 }
  $client = New-Object System.Net.Sockets.TcpClient
  $iar = $client.BeginConnect($u.Host, $port, $null, $null)
  if (-not $iar.AsyncWaitHandle.WaitOne(3000)) { throw "timeout" }
  $client.EndConnect($iar)
  $client.Close()
  Write-Output "  H3 工作台已连接"
  exit 0
} catch {
  Write-Output "  未连接到 H3 工作台"
  exit 1
}
