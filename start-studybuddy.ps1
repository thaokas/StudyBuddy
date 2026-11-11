$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$studyBuddyNode = 'D:/Applications/nvm/app/v26.13.0/node.exe'
if (-not (Test-Path -LiteralPath $studyBuddyNode)) {
    $studyBuddyNode = (Get-Command node -ErrorAction Stop).Source
}
$studyBuddyPreference = $ErrorActionPreference
# pnpm writes progress to stderr even on success; retain the native exit code.
$ErrorActionPreference = 'Continue'
try {
    & $studyBuddyNode (Join-Path $PSScriptRoot 'scripts/start-studybuddy.mjs') @args
    $studyBuddyExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $studyBuddyPreference
}
exit $studyBuddyExitCode
