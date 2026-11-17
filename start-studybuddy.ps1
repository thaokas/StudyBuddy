$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$studyBuddyNode = (Get-Command node -ErrorAction Stop).Source
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
