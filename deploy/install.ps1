# Runs mgu-install with Node 18+: downloads the CN installer, checks it
# against SHA256SUMS, and runs it with the arguments given here
# (deploy/README.md, "mgu-install"). Windows PowerShell 5.1 or PowerShell 7:
#
#   & ([scriptblock]::Create((irm https://mgu.walle.pw/mgu/cn/bootstrap/install.ps1))) first-install --identity $HOME\.ssh\mgu_root_key
#
# $env:MGU_INSTALL_DOWNLOAD names another folder of the same files (a URL).
# mgu-install's exit status is left in $LASTEXITCODE (the script's exit
# status when run as a file); 1 when it could not be fetched.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$base = $env:MGU_INSTALL_DOWNLOAD
if (-not $base) { $base = 'https://mgu.walle.pw/mgu/cn/bootstrap' }
$asFile = [bool]$MyInvocation.MyCommand.Path

function Fail($message) {
    [Console]::Error.WriteLine("mgu-install: $message")
    $global:LASTEXITCODE = 1
    if ($asFile) { exit 1 }
}

# One argument as the Windows C runtime reads it back.
function Quote([string]$a) {
    if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
    $a = [regex]::Replace($a, '(\\*)"', '$1$1\"')
    return '"' + [regex]::Replace($a, '(\\+)$', '$1$1') + '"'
}

function Run([string[]]$argv) {
    # 1 until mgu-install's own exit status replaces it
    $global:LASTEXITCODE = 1
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
        return Fail 'this script is for Windows; on macOS and Linux run install.sh (deploy/README.md)'
    }
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) {
        return Fail 'Node 18 or newer must be installed before running this installer'
    }
    & $node.Source -e 'process.exit(parseInt(process.versions.node)>=18?0:1)'
    if ($LASTEXITCODE -ne 0) {
        return Fail 'Node 18 or newer must be installed before running this installer'
    }
    if (([uri]$base).DnsSafeHost -match '(^|\.)(github\.com|githubusercontent\.com|githubassets\.com|github\.io|ghcr\.io)\.?$') {
        return Fail 'GitHub downloads are not supported by the CN launcher'
    }
    $name = 'mgu-install.js'
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('mgu-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    try {
        try {
            Invoke-WebRequest "$base/SHA256SUMS" -OutFile "$dir\SHA256SUMS" -UseBasicParsing -MaximumRedirection 0
        } catch {
            return Fail "could not download $base/SHA256SUMS: $($_.Exception.Message)"
        }
        $want = $null
        foreach ($line in Get-Content "$dir\SHA256SUMS") {
            $f = $line -split '\s+', 2
            if ($f.Count -eq 2 -and $f[1].TrimStart('*') -eq $name) { $want = $f[0].ToLower() }
        }
        if (-not $want) { return Fail "$base/SHA256SUMS lists no $name" }
        try {
            Invoke-WebRequest "$base/$name" -OutFile "$dir\$name" -UseBasicParsing -MaximumRedirection 0
        } catch {
            return Fail "could not download $base/${name}: $($_.Exception.Message)"
        }
        $got = (Get-FileHash -Algorithm SHA256 "$dir\$name").Hash.ToLower()
        if ($got -ne $want) {
            return Fail "$name does not match SHA256SUMS (sha256 $got, expected $want); nothing was run. Try again in a minute"
        }
        $start = New-Object Diagnostics.ProcessStartInfo $node.Source
        $start.Arguments = (@("$dir\$name") + @($argv) | ForEach-Object { Quote $_ }) -join ' '
        $start.UseShellExecute = $false
        $p = [Diagnostics.Process]::Start($start)
        $p.WaitForExit()
        $global:LASTEXITCODE = $p.ExitCode
        if ($asFile) { exit $p.ExitCode }
    } finally {
        # a virus scanner can hold a file it has just seen for a moment
        foreach ($i in 1..20) {
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
            if (-not (Test-Path $dir)) { break }
            Start-Sleep -Milliseconds 500
        }
    }
}

Run $args
