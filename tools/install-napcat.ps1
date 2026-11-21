<#
.SYNOPSIS
  Install (or repair) the NapCat Shell that the dsh-qq-bot plugin talks to.

.DESCRIPTION
  Downloads the NapCat Shell archive, extracts it, writes an OneBot v11 forward
  WebSocket config on the requested port, registers a logon scheduled task, and
  optionally starts it. Safe to run again: an existing installation is reused
  unless -Force is given.

.PARAMETER InstallDir
  Target directory. Defaults to %USERPROFILE%\NapCat. Must not contain spaces or
  non-ASCII characters (NapCat refuses such paths).

.PARAMETER Port
  OneBot v11 forward WebSocket port. Defaults to 3001.

.PARAMETER Account
  QQ number to quick-login on every start. Omit to sign in by QR code the first
  time; the task is then updated once an account is known.

.PARAMETER Force
  Download and extract again even when an installation already exists.

.PARAMETER NoStart
  Register the task without starting it now.

.EXAMPLE
  .\install-napcat.ps1 -Account 1174293395
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE 'NapCat'),
  [int]$Port = 3001,
  [string]$Account = '',
  [switch]$Force,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$version = '4.18.42'
$taskName = 'NapCat-Bridge'
$mirrors = @(
  "https://gh-proxy.com/https://github.com/XingYunStar/NapCatQQ/releases/download/v$version/NapCat.Shell.zip",
  "https://ghfast.top/https://github.com/XingYunStar/NapCatQQ/releases/download/v$version/NapCat.Shell.zip",
  "https://github.com/XingYunStar/NapCatQQ/releases/download/v$version/NapCat.Shell.zip"
)

function Write-Step([string]$Text) { Write-Host "[napcat] $Text" }

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-QqPath {
  foreach ($key in @(
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ',
      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ')) {
    $entry = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    if ($null -ne $entry -and $entry.UninstallString) {
      $dir = Split-Path -Parent ($entry.UninstallString.Trim('"'))
      $exe = Join-Path $dir 'QQ.exe'
      if (Test-Path -LiteralPath $exe) { return $exe }
    }
  }
  foreach ($candidate in @(
      'C:\Program Files\Tencent\QQNT\QQ.exe',
      'C:\Program Files (x86)\Tencent\QQNT\QQ.exe')) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

if (-not (Test-Admin)) {
  Write-Step 'requesting administrator rights...'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-InstallDir', "`"$InstallDir`"", '-Port', $Port)
  if ($Account -ne '') { $arguments += @('-Account', $Account) }
  if ($Force) { $arguments += '-Force' }
  if ($NoStart) { $arguments += '-NoStart' }
  Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs
  return
}

$qq = Find-QqPath
if ($null -eq $qq) {
  throw 'QQ NT was not found. Install QQ (9.9.x) first, then run this again.'
}
Write-Step "QQ found: $qq"

$archive = Join-Path $env:TEMP "NapCat.Shell.$version.zip"
$launcher = Join-Path $InstallDir 'launcher.bat'
$installed = Test-Path -LiteralPath $launcher

if ($installed -and -not $Force) {
  Write-Step "reusing existing installation: $InstallDir"
} else {
  if ($InstallDir -match '[^\x20-\x7E]' -or $InstallDir -match ' ') {
    throw "InstallDir must not contain spaces or non-ASCII characters: $InstallDir"
  }
  $size = 0
  foreach ($url in $mirrors) {
    try {
      Write-Step "downloading $version from $($url.Split('/')[2]) ..."
      Remove-Item -LiteralPath $archive -ErrorAction SilentlyContinue
      curl.exe -sSL --fail -m 900 -H 'User-Agent: dsh-qq-bot-installer' "$url" -o $archive
      if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $archive)) {
        $size = (Get-Item -LiteralPath $archive).Length
        if ($size -gt 20MB) { break }
      }
    } catch {
      Write-Step "mirror failed: $($_.Exception.Message)"
    }
  }
  if ($size -le 20MB) {
    throw 'all download mirrors failed; download NapCat.Shell.zip manually and extract it to ' + $InstallDir
  }
  Write-Step ("downloaded {0:N1} MB" -f ($size / 1MB))
  if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Write-Step "extracting to $InstallDir ..."
  Expand-Archive -LiteralPath $archive -DestinationPath $InstallDir -Force
  Remove-Item -LiteralPath $archive -ErrorAction SilentlyContinue
}

$configDir = Join-Path $InstallDir 'config'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$onebot = Join-Path $configDir 'onebot11.json'
if (-not (Test-Path -LiteralPath $onebot) -or $Force) {
  $config = [ordered]@{
    network           = [ordered]@{
      httpServers      = @()
      httpSseServers   = @()
      httpClients      = @()
      websocketServers = @([ordered]@{
          name                = 'dsh-bridge'
          enable              = $true
          host                = '127.0.0.1'
          port                = $Port
          messagePostFormat   = 'array'
          reportSelfMessage   = $false
          token               = ''
          enableForcePushEvent = $true
          debug               = $false
          heartInterval       = 30000
        })
      websocketClients = @()
      plugins          = @()
    }
    musicSignUrl       = ''
    enableLocalFile2Url = $false
    parseMultMsg       = $false
    imageDownloadProxy = ''
    timeout            = [ordered]@{ baseTimeout = 10000; uploadSpeedKBps = 256; downloadSpeedKBps = 256; maxTimeout = 1800000 }
  }
  $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $onebot -Encoding UTF8
  Write-Step "wrote OneBot config (ws://127.0.0.1:$Port)"
}

$actionArguments = "/c `"$launcher`""
if ($Account -ne '') { $actionArguments += " -q $Account" }
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $actionArguments -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = 'PT45S'
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'NapCat Shell for the dsh-qq-bot plugin' | Out-Null
Write-Step "registered scheduled task $taskName (auto-start at logon, 45s delay)"

# The plain QQ autostart steals the bot session; remove it when present.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$qqRun = (Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).QQNT
if ($null -ne $qqRun) {
  Write-Step "removing conflicting QQ autostart entry: $qqRun"
  Remove-ItemProperty -Path $runKey -Name 'QQNT' -ErrorAction SilentlyContinue
}

if (-not $NoStart) {
  Write-Step 'starting NapCat ...'
  if (Get-Process -Name QQ -ErrorAction SilentlyContinue) {
    & cmd.exe /c (Join-Path $InstallDir 'KillQQ.bat') | Out-Null
    Start-Sleep -Seconds 3
  }
  Start-ScheduledTask -TaskName $taskName
}

Write-Host ''
Write-Host 'NapCat is ready.'
Write-Host "  install dir : $InstallDir"
Write-Host "  OneBot WS   : ws://127.0.0.1:$Port"
Write-Host "  WebUI       : http://127.0.0.1:6099/webui  (token in config\webui.json)"
if ($Account -eq '') {
  Write-Host '  sign in     : scan the QR code shown by NapCat, or open the WebUI.'
}
Write-Host ''
