# Writes to logs/api-run.log (avoids lock if apps/api/api-run.log is open in the editor).
# Usage (from apps/api): npm run dev:log
# Other terminal: Get-Content .\logs\api-run.log -Wait -Tail 50

$ErrorActionPreference = "Stop"
$apiRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $apiRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir "api-run.log"

try {
  "" | Out-File -FilePath $logPath -Encoding utf8 -Force
} catch {
  $logPath = Join-Path $logDir "api-run-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
  "" | Out-File -FilePath $logPath -Encoding utf8 -Force
}
Set-Location $apiRoot

npm run dev 2>&1 | Tee-Object -FilePath $logPath -Append
