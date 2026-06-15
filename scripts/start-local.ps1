$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$serverLog = Join-Path $root "server.log"
$serverErr = Join-Path $root "server.err.log"
$workerLog = Join-Path $root "worker.log"
$workerErr = Join-Path $root "worker.err.log"
$url = "http://localhost:3000"
$browserProfileDir = Join-Path $env:TEMP "grid-trader-pro-browser-profile"

function Stop-ProcessTree {
  param([int]$ProcessId)

  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId }
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId
  }

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Stop-ExistingTraderProcesses {
  $escapedRoot = [regex]::Escape($root.Path)
  $processes = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -match $escapedRoot -and
    (
      $_.CommandLine -match "npm-cli\.js.*run dev" -or
      $_.CommandLine -match "npm-cli\.js.*run start" -or
      $_.CommandLine -match "next.*dev" -or
      $_.CommandLine -match "next.*start" -or
      $_.CommandLine -match "npm-cli\.js.*run worker" -or
      $_.CommandLine -match "tsx.*src[/\\]worker[/\\]live-runner\.ts"
    )
  }

  foreach ($process in $processes) {
    Stop-ProcessTree -ProcessId $process.ProcessId
  }
}

function Stop-LocalPortProcesses {
  param([int]$Port)

  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    if (
      $process -and
      $process.Name -eq "node.exe" -and
      $process.CommandLine -match [regex]::Escape($root.Path)
    ) {
      Stop-ProcessTree -ProcessId $process.ProcessId
    }
  }
}

function Stop-TraderServices {
  param(
    [System.Diagnostics.Process]$ServerProcess,
    [System.Diagnostics.Process]$WorkerProcess,
    [System.Diagnostics.Process]$BrowserProcess
  )

  Stop-TraderBrowser -BrowserProcess $BrowserProcess

  if ($ServerProcess) {
    Stop-ProcessTree -ProcessId $ServerProcess.Id
  }
  if ($WorkerProcess) {
    Stop-ProcessTree -ProcessId $WorkerProcess.Id
  }

  Stop-ExistingTraderProcesses
  Stop-LocalPortProcesses -Port 3000
}

function Find-ChromePath {
  $candidates = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  $command = Get-Command "chrome.exe" -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  return $null
}

function Start-TraderBrowser {
  param([string]$TargetUrl)

  $chromePath = Find-ChromePath
  if (-not $chromePath) {
    Write-Host "Chrome not found. Opening default browser instead." -ForegroundColor Yellow
    Start-Process $TargetUrl
    return $null
  }

  New-Item -ItemType Directory -Path $browserProfileDir -Force | Out-Null
  $arguments = @(
    "--app=$TargetUrl",
    "--user-data-dir=$browserProfileDir",
    "--no-first-run",
    "--disable-session-crashed-bubble"
  )

  return Start-Process -FilePath $chromePath -ArgumentList $arguments -PassThru
}

function Stop-TraderBrowser {
  param([System.Diagnostics.Process]$BrowserProcess)

  $escapedProfile = [regex]::Escape($browserProfileDir)
  $browserProcesses = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "chrome.exe" -or $_.Name -eq "msedge.exe") -and
    $_.CommandLine -match $escapedProfile
  }

  foreach ($process in $browserProcesses) {
    Stop-ProcessTree -ProcessId $process.ProcessId
  }

  if ($BrowserProcess) {
    Stop-ProcessTree -ProcessId $BrowserProcess.Id
  }
}

function Wait-ForUrl {
  param(
    [string]$TargetUrl,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $TargetUrl -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return $true
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  return $false
}

Set-Location $root

Write-Host ""
Write-Host "Grid Trader Pro local launcher" -ForegroundColor Cyan
Write-Host "Project: $root"
Write-Host ""

Write-Host "Stopping old local dev/worker processes for this project..."
Stop-ExistingTraderProcesses
Stop-LocalPortProcesses -Port 3000
Start-Sleep -Seconds 2

"" | Set-Content -Path $serverLog
"" | Set-Content -Path $serverErr
"" | Set-Content -Path $workerLog
"" | Set-Content -Path $workerErr

if (-not (Test-Path (Join-Path $root ".next\BUILD_ID"))) {
  Write-Host "Production build not found." -ForegroundColor Yellow
  Write-Host "Run this once first: npm run build"
  Read-Host "Press ENTER to close" | Out-Null
  exit 1
}

Write-Host "Starting production dashboard..."
$serverProcess = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "start" -WorkingDirectory $root -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr -WindowStyle Hidden -PassThru

Write-Host "Starting MT5 worker..."
$workerProcess = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "worker" -WorkingDirectory $root -RedirectStandardOutput $workerLog -RedirectStandardError $workerErr -WindowStyle Hidden -PassThru

Write-Host "Waiting for dashboard: $url"
if (Wait-ForUrl -TargetUrl $url -TimeoutSeconds 90) {
  Write-Host "Dashboard ready. Opening browser..." -ForegroundColor Green
  $browserProcess = Start-TraderBrowser -TargetUrl $url
} else {
  Write-Host "Dashboard did not respond within 90 seconds. Check server.err.log." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Running in one launcher window." -ForegroundColor Green
Write-Host "URL: $url"
Write-Host "Server log: $serverLog"
Write-Host "Worker log: $workerLog"
Write-Host ""
Write-Host "Press ENTER here to stop dashboard + worker safely."
Read-Host | Out-Null

Write-Host "Stopping services..."
Stop-TraderServices -ServerProcess $serverProcess -WorkerProcess $workerProcess -BrowserProcess $browserProcess
Write-Host "Stopped. You can close this window." -ForegroundColor Green
