[CmdletBinding()]
param(
    [ValidateRange(10, 600)]
    [int] $DockerStartupTimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RootDir = $PSScriptRoot
$AgentDir = Join-Path $RootDir 'agent-service'
$BackendDir = Join-Path $RootDir 'backend'
$FrontendDir = Join-Path $RootDir 'frontend'
$ComposeFile = Join-Path $BackendDir 'docker-compose.yml'
$RuntimeDir = Join-Path $RootDir 'logs\dev'
$StateFile = Join-Path $RuntimeDir 'processes.json'

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

function Resolve-RequiredCommand {
    param(
        [Parameter(Mandatory)]
        [string[]] $Names,
        [Parameter(Mandatory)]
        [string] $InstallHint
    )

    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command) {
            return $command.Source
        }
    }

    throw "Required command was not found: $($Names -join ' or '). $InstallHint"
}

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

function Save-ProcessState {
    param([Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Entries)

    if ($Entries.Count -eq 0) {
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        return
    }

    $Entries | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
}

function Start-TrackedProcess {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $FilePath,
        [Parameter(Mandatory)] [string[]] $ArgumentList,
        [Parameter(Mandatory)] [string] $WorkingDirectory
    )

    if ($Name -eq 'backend') {
        $listener = Get-TcpListener -Port 8080
        if ($null -ne $listener) {
            if (Test-BackendServiceReady -Port 8080) {
                $process = Get-Process -Id $listener.Pid -ErrorAction SilentlyContinue
                if ($null -ne $process) {
                    $script:ProcessState = @($script:ProcessState | Where-Object { $_.Name -ne $Name })
                    $entry = [PSCustomObject]@{
                        Name = $Name
                        Pid = $listener.Pid
                        StartedAtUtc = $process.StartTime.ToUniversalTime().ToString('o')
                        Stdout = Join-Path $RuntimeDir "$Name.stdout.log"
                        Stderr = Join-Path $RuntimeDir "$Name.stderr.log"
                    }

                    $script:ProcessState += $entry
                    Save-ProcessState -Entries $script:ProcessState
                    Write-Host "$Name is already running (PID $($listener.Pid))."
                    return
                }
            }

            $details = if (-not [string]::IsNullOrWhiteSpace($listener.CommandLine)) {
                " Command line: $($listener.CommandLine)."
            }
            else {
                ''
            }

            throw "Port 8080 is already in use by $($listener.ProcessName) (PID $($listener.Pid)). Stop that process, or change backend/src/main/resources/application.yml to use a different server.port before starting the backend.$details"
        }
    }

    $existing = $script:ProcessState | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
    if ($null -ne $existing -and (Test-TrackedProcess -Entry $existing)) {
        Write-Host "$Name is already running (PID $($existing.Pid))."
        return
    }

    $script:ProcessState = @($script:ProcessState | Where-Object { $_.Name -ne $Name })
    $stdoutPath = Join-Path $RuntimeDir "$Name.stdout.log"
    $stderrPath = Join-Path $RuntimeDir "$Name.stderr.log"

    $process = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $WorkingDirectory `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -PassThru

    $entry = [PSCustomObject]@{
        Name = $Name
        Pid = $process.Id
        StartedAtUtc = $process.StartTime.ToUniversalTime().ToString('o')
        Stdout = $stdoutPath
        Stderr = $stderrPath
    }

    $script:ProcessState += $entry
    Save-ProcessState -Entries $script:ProcessState
    Write-Host "Started $Name (PID $($process.Id))."
}

function Assert-TrackedProcessAlive {
    param([Parameter(Mandatory)] [string] $Name)

    $entry = $script:ProcessState | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
    if ($null -ne $entry -and (Test-TrackedProcess -Entry $entry)) {
        return
    }

    $script:ProcessState = @($script:ProcessState | Where-Object { $_.Name -ne $Name })
    Save-ProcessState -Entries $script:ProcessState
    throw "$Name exited before becoming ready. See $RuntimeDir\$Name.stdout.log and $RuntimeDir\$Name.stderr.log."
}

function Test-DockerEngine {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $script:DockerPath
    $startInfo.Arguments = 'version --format "{{.Server.Version}}"'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo

    try {
        [void] $process.Start()
        if (-not $process.WaitForExit(5000)) {
            try {
                $process.Kill()
            }
            catch {
                # The process may exit between the timeout and termination attempt.
            }
            [void] $process.WaitForExit()
            return $false
        }

        return $process.ExitCode -eq 0
    }
    finally {
        $process.Dispose()
    }
}

function Wait-DockerEngine {
    param([Parameter(Mandatory)] [int] $TimeoutSeconds)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-DockerEngine) {
            Write-Host 'Docker engine is ready.'
            return
        }

        Start-Sleep -Seconds 2
    }

    throw "Docker Desktop did not make the Linux engine available within $TimeoutSeconds seconds. Open Docker Desktop, ensure it is running with Linux containers, then run .\start.ps1 again."
}

function Ensure-DockerEngine {
    if (Test-DockerEngine) {
        Write-Host 'Docker engine is ready.'
        return
    }

    if ($env:OS -ne 'Windows_NT') {
        throw 'Docker engine is not available. Start Docker before running this script again.'
    }

    $desktopCandidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
        (Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe')
    )
    $desktopPath = $desktopCandidates |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    $desktopProcess = Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue | Select-Object -First 1

    if ($null -eq $desktopProcess) {
        if ($null -eq $desktopPath) {
            throw 'Docker engine is not running, and Docker Desktop could not be found. Start Docker Desktop manually, then run .\start.ps1 again.'
        }

        Write-Host 'Docker engine is not running. Starting Docker Desktop...'
        Start-Process -FilePath $desktopPath -WindowStyle Hidden | Out-Null
    }
    else {
        Write-Host 'Docker Desktop is running. Waiting for the Docker engine...'
    }

    Wait-DockerEngine -TimeoutSeconds $DockerStartupTimeoutSeconds
}

function Wait-ComposeServiceHealthy {
    param(
        [Parameter(Mandatory)] [string] $ServiceName,
        [int] $TimeoutSeconds = 60
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $containerId = (& $script:DockerPath compose -f $ComposeFile ps -q $ServiceName 2>$null)
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace("$containerId")) {
            $status = (& $script:DockerPath inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$containerId".Trim() 2>$null)
            $readyStatus = "$status".Trim()
            if ($LASTEXITCODE -eq 0 -and $readyStatus -in @('healthy', 'running')) {
                Write-Host "$ServiceName container is ready ($readyStatus)."
                return
            }
        }

        Start-Sleep -Seconds 2
    }

    throw "Compose service $ServiceName did not become healthy within $TimeoutSeconds seconds."
}

function Wait-HttpEndpoint {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Uri,
        [string] $TrackedProcessName,
        [int] $TimeoutSeconds = 90
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2 | Out-Null
            Write-Host "$Name is ready at $Uri"
            return
        }
        catch {
            if (-not [string]::IsNullOrWhiteSpace($TrackedProcessName)) {
                Assert-TrackedProcessAlive -Name $TrackedProcessName
            }
            Start-Sleep -Seconds 2
        }
    }

    throw "$Name did not become ready within $TimeoutSeconds seconds. See logs in $RuntimeDir."
}

function Test-TcpConnection {
    param(
        [Parameter(Mandatory)] [string] $HostName,
        [Parameter(Mandatory)] [int] $Port
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $result = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $result.AsyncWaitHandle.WaitOne(500)) {
            return $false
        }

        $client.EndConnect($result)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Get-TcpListener {
    param(
        [Parameter(Mandatory)] [int] $Port
    )

    $netstat = & netstat.exe -ano -p tcp 2>$null
    foreach ($line in $netstat) {
        if ($line -match '^\s*TCP\s+\S+:(?<Port>\d+)\s+\S+\s+LISTENING\s+(?<Pid>\d+)\s*$' -and [int] $Matches.Port -eq $Port) {
            $pid = [int] $Matches.Pid
            $process = Get-Process -Id $pid -ErrorAction SilentlyContinue
            $commandLine = $null

            try {
                $cimProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $pid" -ErrorAction Stop | Select-Object -First 1
                if ($null -ne $cimProcess) {
                    $commandLine = $cimProcess.CommandLine
                }
            }
            catch {
                $commandLine = $null
            }

            return [PSCustomObject]@{
                Pid = $pid
                ProcessName = if ($null -ne $process) { $process.ProcessName } else { $null }
                CommandLine = $commandLine
            }
        }
    }

    return $null
}

function Test-BackendServiceReady {
    param(
        [Parameter(Mandatory)] [int] $Port
    )

    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api-docs" -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Wait-TcpPort {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [int] $Port,
        [string] $TrackedProcessName,
        [int] $TimeoutSeconds = 120
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-TcpConnection -HostName 'localhost' -Port $Port) {
            Write-Host "$Name is ready on http://localhost:$Port"
            return
        }

        if (-not [string]::IsNullOrWhiteSpace($TrackedProcessName)) {
            Assert-TrackedProcessAlive -Name $TrackedProcessName
        }
        Start-Sleep -Seconds 2
    }

    throw "$Name did not listen on port $Port within $TimeoutSeconds seconds. See logs in $RuntimeDir."
}

$DockerPath = Resolve-RequiredCommand -Names @('docker') -InstallHint 'Install and start Docker Desktop.'
$UvPath = Resolve-RequiredCommand -Names @('uv') -InstallHint 'Install uv for the Agent service.'
$MavenPath = Resolve-RequiredCommand -Names @('mvn.cmd', 'mvn') -InstallHint 'Install Maven 3.8 or later.'
$NpmPath = Resolve-RequiredCommand -Names @('npm.cmd', 'npm') -InstallHint 'Install Node.js and npm.'

if (-not (Test-Path -LiteralPath (Join-Path $AgentDir '.env'))) {
    Write-Warning 'agent-service\.env is missing. Create it from .env.example and configure the LLM key before using AI features.'
}
if (-not (Test-Path -LiteralPath (Join-Path $FrontendDir 'node_modules'))) {
    throw 'Frontend dependencies are missing. Run npm install in frontend before starting the project.'
}

$ProcessState = @(Read-ProcessState | Where-Object { Test-TrackedProcess -Entry $_ })
Save-ProcessState -Entries $ProcessState

Ensure-DockerEngine
Write-Host 'Starting PostgreSQL and Redis containers...'
& $DockerPath compose -f $ComposeFile up -d
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Compose failed to start backend dependencies.'
}
Wait-ComposeServiceHealthy -ServiceName 'postgres'
Wait-ComposeServiceHealthy -ServiceName 'redis'

Start-TrackedProcess `
    -Name 'agent' `
    -FilePath $UvPath `
    -ArgumentList @('run', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000', '--reload') `
    -WorkingDirectory $AgentDir
Wait-HttpEndpoint -Name 'Agent service' -Uri 'http://127.0.0.1:8000/health' -TrackedProcessName 'agent' -TimeoutSeconds 300

Start-TrackedProcess `
    -Name 'backend' `
    -FilePath $MavenPath `
    -ArgumentList @('spring-boot:run') `
    -WorkingDirectory $BackendDir
Wait-TcpPort -Name 'Backend service' -Port 8080 -TrackedProcessName 'backend' -TimeoutSeconds 300

Start-TrackedProcess `
    -Name 'frontend' `
    -FilePath $NpmPath `
    -ArgumentList @('run', 'dev', '--', '--strictPort') `
    -WorkingDirectory $FrontendDir
Wait-TcpPort -Name 'Frontend service' -Port 3000 -TrackedProcessName 'frontend'

Write-Host ''
Write-Host 'StudyBuddy is running:'
Write-Host '  Frontend: http://localhost:3000'
Write-Host '  Backend:  http://localhost:8080/swagger-ui.html'
Write-Host '  Agent:    http://127.0.0.1:8000/docs'
Write-Host "  Logs:     $RuntimeDir"
Write-Host 'Use .\stop.ps1 to stop all services started by this script.'
