# Recreate the normal-integrity copy of the pinned Electron distribution used by smoke-desktop.mjs.
# Reason (baseline.md section 7): the project tree inherits the Low mandatory integrity label of an
# earlier low-integrity sandbox, and Electron 44.7.0 aborts during GUI start-up when electron.exe
# carries that label. A byte-identical copy on a normal-integrity directory starts normally.
# This script does not change the pinned Electron version; it verifies the SHA-256 of the copy.
param(
  [string]$Destination = (Join-Path $env:TEMP 'a01-electron-runtime')
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..\..\..')
$dist = Join-Path $root 'source\deepseek-harness\node_modules\.pnpm\electron@44.7.0_supports-color@9.4.0\node_modules\electron\dist'
if (-not (Test-Path (Join-Path $dist 'electron.exe'))) { throw "pinned Electron dist not found: $dist" }

$sourceHash = (Get-FileHash (Join-Path $dist 'electron.exe') -Algorithm SHA256).Hash
if (Test-Path $Destination) { Remove-Item $Destination -Recurse -Force }
robocopy $dist $Destination /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }

$copyHash = (Get-FileHash (Join-Path $Destination 'electron.exe') -Algorithm SHA256).Hash
if ($sourceHash -ne $copyHash) { throw "hash mismatch: $sourceHash != $copyHash" }

$label = (icacls (Join-Path $Destination 'electron.exe') | Select-String 'Mandatory').Line
if ($label) { Write-Warning "copy still carries an integrity label: $label" }

Write-Output "electron runtime: $Destination"
Write-Output "electron.exe sha256: $copyHash"
Write-Output "next: `$env:A01_ELECTRON_DIST = '$Destination'; node smoke-desktop.mjs"
