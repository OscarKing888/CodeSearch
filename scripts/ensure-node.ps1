param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [int]$MinMajor = 20,
  [int]$PortableMajor = 24,
  [string]$CmdFile
)

$ErrorActionPreference = 'Stop'

function Get-NodeInfo {
  param([string]$NodeExe)

  try {
    $version = & $NodeExe -p "process.versions.node" 2>$null
    if (-not $version) {
      return $null
    }

    $major = [int](($version.Trim() -split '\.')[0])
    return [PSCustomObject]@{
      Exe = $NodeExe
      Dir = Split-Path -Parent $NodeExe
      Version = $version.Trim()
      Major = $major
    }
  } catch {
    return $null
  }
}

function Write-CmdEnvironment {
  param([string]$NodeDir)

  if (-not $CmdFile) {
    return
  }

  $content = @(
    "set `"ACS_NODE_DIR=$NodeDir`"",
    "set `"PATH=$NodeDir;%PATH%`""
  )
  Set-Content -LiteralPath $CmdFile -Encoding ASCII -Value $content
}

function Get-WindowsNodeArch {
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    return 'win-arm64'
  }

  return 'win-x64'
}

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )

  $parentPath = (Resolve-Path -LiteralPath $Parent).Path
  $childPath = (Resolve-Path -LiteralPath $Child).Path

  if (-not $childPath.StartsWith($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside expected directory: $childPath"
  }
}

$rootPath = (Resolve-Path -LiteralPath $Root).Path
$systemNode = Get-Command node -ErrorAction SilentlyContinue
if ($systemNode) {
  $systemInfo = Get-NodeInfo $systemNode.Source
  if ($systemInfo -and $systemInfo.Major -ge $MinMajor) {
    Write-Host "Using Node.js v$($systemInfo.Version): $($systemInfo.Exe)"
    Write-CmdEnvironment $systemInfo.Dir
    exit 0
  }

  if ($systemInfo) {
    Write-Host "System Node.js v$($systemInfo.Version) is below required v$MinMajor; using project-local Node.js $PortableMajor instead."
  }
}

$toolsDir = Join-Path $rootPath '.tools'
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

$arch = Get-WindowsNodeArch
$existing = Get-ChildItem -LiteralPath $toolsDir -Directory -Filter "node-v$PortableMajor.*-$arch" -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending

foreach ($entry in $existing) {
  $nodeExe = Join-Path $entry.FullName 'node.exe'
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    continue
  }

  $info = Get-NodeInfo $nodeExe
  if ($info -and $info.Major -ge $MinMajor) {
    Write-Host "Using project-local Node.js v$($info.Version): $nodeExe"
    Write-CmdEnvironment $entry.FullName
    exit 0
  }
}

$distBase = "https://nodejs.org/dist/latest-v$PortableMajor.x"
$shasumsUrl = "$distBase/SHASUMS256.txt"
Write-Host "Downloading Node.js $PortableMajor metadata from $shasumsUrl"
$shasums = (Invoke-WebRequest -Uri $shasumsUrl -UseBasicParsing).Content
$zipPattern = "node-v$PortableMajor\.[^\s]*-$arch\.zip"
$zipMatch = [regex]::Match($shasums, $zipPattern)

if (-not $zipMatch.Success) {
  throw "Could not find a Node.js $PortableMajor $arch zip in $shasumsUrl"
}

$zipName = $zipMatch.Value
$zipLine = ($shasums -split "`n" | Where-Object { $_ -match [regex]::Escape($zipName) } | Select-Object -First 1).Trim()
$expectedHash = ($zipLine -split '\s+')[0].ToLowerInvariant()
$zipPath = Join-Path $toolsDir $zipName

if (-not (Test-Path -LiteralPath $zipPath)) {
  $zipUrl = "$distBase/$zipName"
  Write-Host "Downloading $zipUrl"
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
}

$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  Remove-Item -LiteralPath $zipPath -Force
  throw "Downloaded Node.js archive failed SHA256 verification."
}

$extractDir = Join-Path $toolsDir ("node-extract-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

try {
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
  $expandedDir = Join-Path $extractDir ($zipName -replace '\.zip$', '')
  $destDir = Join-Path $toolsDir ($zipName -replace '\.zip$', '')

  if (-not (Test-Path -LiteralPath $destDir)) {
    Move-Item -LiteralPath $expandedDir -Destination $destDir
  }

  $nodeExe = Join-Path $destDir 'node.exe'
  $info = Get-NodeInfo $nodeExe
  if (-not $info -or $info.Major -lt $MinMajor) {
    throw "Project-local Node.js was installed but does not satisfy Node.js $MinMajor+."
  }

  Write-Host "Using project-local Node.js v$($info.Version): $nodeExe"
  Write-CmdEnvironment $destDir
} finally {
  if (Test-Path -LiteralPath $extractDir) {
    Assert-ChildPath -Parent $toolsDir -Child $extractDir
    Remove-Item -LiteralPath $extractDir -Recurse -Force
  }
}
