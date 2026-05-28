[CmdletBinding()]
param(
    [switch] $KeepContainers
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = $PSScriptRoot
$ComposeFile = Join-Path $RootDir 'backend\docker-compose.yml'
$RuntimeDir = Join-Path $RootDir 'logs\dev'
$StateFile = Join-Path $RuntimeDir 'processes.json'

function Read-ProcessState {
    if (-not (Test-Path -LiteralPath $StateFile)) {
        return @()
    }

    try {
        return @(Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json)
    }
    catch {
        Write-Warning "Ignoring invalid process state file: $StateFile"
        return @()
    }
}

function Test-TrackedProcess {
    param([Parameter(Mandatory)] $Entry)

    try {
        $process = Get-Process -Id ([int] $Entry.Pid) -ErrorAction Stop
        return $process.StartTime.ToUniversalTime().ToString('o') -eq [string] $Entry.StartedAtUtc
    }
    catch {
        return $false
    }
}

function Stop-TrackedProcessTree {
    param([Parameter(Mandatory)] $Entry)

    if (-not (Test-TrackedProcess -Entry $Entry)) {
        Write-Host "$($Entry.Name) is not running."
        return
    }

    if ($env:OS -eq 'Windows_NT') {
        & taskkill.exe /PID ([int] $Entry.Pid) /T /F | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to stop $($Entry.Name) process tree (PID $($Entry.Pid))."
        }
    }
    else {
        Stop-Process -Id ([int] $Entry.Pid) -Force
    }

    Write-Host "Stopped $($Entry.Name) (PID $($Entry.Pid))."
}

$processState = Read-ProcessState
foreach ($name in @('frontend', 'backend', 'agent')) {
    $entry = $processState | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if ($null -ne $entry) {
        Stop-TrackedProcessTree -Entry $entry
    }
    else {
        Write-Host "$name has no tracked process."
    }
}

Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue

if ($KeepContainers) {
    Write-Host 'Leaving PostgreSQL and Redis containers running because -KeepContainers was specified.'
}
else {
    $dockerCommand = Get-Command docker -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $dockerCommand) {
        Write-Warning 'Docker was not found; PostgreSQL and Redis containers were not stopped.'
    }
    else {
        Write-Host 'Stopping PostgreSQL and Redis containers...'
        & $dockerCommand.Source compose -f $ComposeFile down
        if ($LASTEXITCODE -ne 0) {
            throw 'Docker Compose failed to stop backend dependencies.'
        }
        Write-Host 'Containers stopped. Named database volumes were preserved.'
    }
}

Write-Host 'PrepKeeper has been stopped.'
