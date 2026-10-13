param(
  [string] $TargetDir = ""
)

$ErrorActionPreference = 'Stop'

function Get-EnvOrDefault {
  param(
    [string] $Name,
    [string] $Default
  )

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $Default
  }

  return $value
}

function Get-GitHubHeaders {
  $headers = @{
    'User-Agent' = 'inpx-shelf-release-builder'
    'X-GitHub-Api-Version' = '2022-11-28'
  }

  $token = [Environment]::GetEnvironmentVariable('GITHUB_TOKEN')
  if (-not [string]::IsNullOrWhiteSpace($token)) {
    $headers.Authorization = "Bearer $token"
  }

  return $headers
}

function Reset-Directory {
  param([string] $Path)

  if (Test-Path $Path) {
    Remove-Item $Path -Recurse -Force
  }

  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Download-File {
  param(
    [string] $Uri,
    [string] $OutFile
  )

  Invoke-WebRequest -Uri $Uri -OutFile $OutFile
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($TargetDir)) {
  $TargetDir = Join-Path $repoRoot 'dist/win'
}

$targetDir = (Resolve-Path $TargetDir).Path
$binDir = Join-Path $targetDir 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$headers = Get-GitHubHeaders
$sevenZipReleaseApi = Get-EnvOrDefault 'WINDOWS_7ZIP_RELEASE_API' 'https://api.github.com/repos/ip7z/7zip/releases/latest'
$windowsJxlUrl = Get-EnvOrDefault 'WINDOWS_JXL_URL' 'https://github.com/libjxl/libjxl/releases/latest/download/jxl-x64-windows-static.zip'
$windowsWebpUrl = Get-EnvOrDefault 'WINDOWS_WEBP_URL' 'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-windows-x64.zip'
$fb2cngReleaseApi = Get-EnvOrDefault 'FB2CNG_RELEASE_API' 'https://api.github.com/repos/vvorth/fb2cng/releases/tags/v1.9.1-forcejpeg-1'

Write-Host "Bundling Windows tools into $binDir"

$sevenZipRelease = Invoke-RestMethod -Uri $sevenZipReleaseApi -Headers $headers
$sevenZipAsset = $sevenZipRelease.assets |
  Where-Object { $_.name -like '7z*-extra.7z' } |
  Select-Object -First 1
$sevenZipBootstrapAsset = $sevenZipRelease.assets |
  Where-Object { $_.name -eq '7zr.exe' } |
  Select-Object -First 1

if (-not $sevenZipAsset) {
  throw 'Unable to find 7-Zip extra package in the latest release'
}
if (-not $sevenZipBootstrapAsset) {
  throw 'Unable to find 7-Zip bootstrap extractor in the latest release'
}

$sevenZipArchive = Join-Path $env:TEMP $sevenZipAsset.name
$sevenZipBootstrap = Join-Path $env:TEMP '7zr-bootstrap.exe'
$sevenZipExtract = Join-Path $env:TEMP 'inpx-shelf-7zip-extra'
Reset-Directory $sevenZipExtract

Download-File $sevenZipAsset.browser_download_url $sevenZipArchive
Download-File $sevenZipBootstrapAsset.browser_download_url $sevenZipBootstrap
& $sevenZipBootstrap x $sevenZipArchive "-o$sevenZipExtract" -y
$sevenZipSource = Get-ChildItem -Path $sevenZipExtract -Recurse -File -Filter '7za.exe' | Select-Object -First 1
if (-not $sevenZipSource) {
  throw 'Unable to find 7za.exe in the 7-Zip extra package'
}
$sevenZipTool = Join-Path $binDir '7za.exe'
Copy-Item $sevenZipSource.FullName -Destination $sevenZipTool -Force

$jxlArchive = Join-Path $env:TEMP 'jxl-x64-windows-static.zip'
$jxlExtract = Join-Path $env:TEMP 'inpx-shelf-jxl-x64-windows-static'
Reset-Directory $jxlExtract
Download-File $windowsJxlUrl $jxlArchive
& $sevenZipTool x $jxlArchive "-o$jxlExtract" -y
Get-ChildItem -Path $jxlExtract -Recurse -File |
  Where-Object { $_.Extension -in @('.exe', '.dll') } |
  ForEach-Object {
    Copy-Item $_.FullName -Destination (Join-Path $binDir $_.Name) -Force
  }

$webpArchive = Join-Path $env:TEMP 'libwebp-windows-x64.zip'
$webpExtract = Join-Path $env:TEMP 'inpx-shelf-libwebp-windows-x64'
Reset-Directory $webpExtract
Download-File $windowsWebpUrl $webpArchive
& $sevenZipTool x $webpArchive "-o$webpExtract" -y
Get-ChildItem -Path $webpExtract -Recurse -File |
  Where-Object { $_.Extension -in @('.exe', '.dll') } |
  ForEach-Object {
    Copy-Item $_.FullName -Destination (Join-Path $binDir $_.Name) -Force
  }

$fb2cngRelease = Invoke-RestMethod -Uri $fb2cngReleaseApi -Headers $headers
$fb2cngAsset = $fb2cngRelease.assets |
  Where-Object { $_.name -eq 'fbc-windows-amd64.zip' } |
  Select-Object -First 1
if (-not $fb2cngAsset) {
  throw 'Unable to find fbc-windows-amd64.zip in the fb2cng release'
}

$fbcArchive = Join-Path $env:TEMP $fb2cngAsset.name
$fbcExtract = Join-Path $env:TEMP 'inpx-shelf-fb2cng-win'
Reset-Directory $fbcExtract
Download-File $fb2cngAsset.browser_download_url $fbcArchive
& $sevenZipTool x $fbcArchive "-o$fbcExtract" -y
$fbcSource = Get-ChildItem -Path $fbcExtract -Recurse -File |
  Where-Object { $_.Name -eq 'fbc.exe' } |
  Select-Object -First 1
if (-not $fbcSource) {
  throw 'Unable to find fbc.exe in fbc-windows-amd64.zip'
}
Copy-Item $fbcSource.FullName -Destination (Join-Path $binDir 'fbc.exe') -Force

Write-Host 'Windows tool bundle complete.'
