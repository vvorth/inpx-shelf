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

function Download-File {
  param(
    [string] $Uri,
    [string] $OutFile
  )

  Invoke-WebRequest -Uri $Uri -OutFile $OutFile
}

# Expand-Archive cannot read Deflate64 (used by the libjxl 0.12 zip): extract with the bundled 7-Zip WebAssembly build.
# Only the program the app runs is copied; it needs no DLLs beyond Windows system ones.
function Extract-ZipFile {
  param(
    [string] $Archive,
    [string] $FileName,
    [string] $OutDir
  )

  & node (Join-Path $repoRoot 'build/extract-zip-file.js') $Archive $FileName $OutDir
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to extract $FileName from $Archive"
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($TargetDir)) {
  $TargetDir = Join-Path $repoRoot 'dist/win'
}

$targetDir = (Resolve-Path $TargetDir).Path
$binDir = Join-Path $targetDir 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$headers = Get-GitHubHeaders
$windowsJxlUrl = Get-EnvOrDefault 'WINDOWS_JXL_URL' 'https://github.com/libjxl/libjxl/releases/download/v0.12.0/jxl-x64-windows-static.zip'
$windowsWebpUrl = Get-EnvOrDefault 'WINDOWS_WEBP_URL' 'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-windows-x64.zip'
$fb2cngReleaseApi = Get-EnvOrDefault 'FB2CNG_RELEASE_API' 'https://api.github.com/repos/rupor-github/fb2cng/releases/latest'

Write-Host "Bundling Windows tools into $binDir"

$jxlArchive = Join-Path $env:TEMP 'jxl-x64-windows-static.zip'
Download-File $windowsJxlUrl $jxlArchive
Extract-ZipFile $jxlArchive 'djxl.exe' $binDir

$webpArchive = Join-Path $env:TEMP 'libwebp-windows-x64.zip'
Download-File $windowsWebpUrl $webpArchive
Extract-ZipFile $webpArchive 'dwebp.exe' $binDir

$fb2cngRelease = Invoke-RestMethod -Uri $fb2cngReleaseApi -Headers $headers
$fb2cngAsset = $fb2cngRelease.assets |
  Where-Object { $_.name -eq 'fbc-windows-amd64.zip' } |
  Select-Object -First 1
if (-not $fb2cngAsset) {
  throw 'Unable to find fbc-windows-amd64.zip in the latest fb2cng release'
}

$fbcArchive = Join-Path $env:TEMP $fb2cngAsset.name
Download-File $fb2cngAsset.browser_download_url $fbcArchive
Extract-ZipFile $fbcArchive 'fbc.exe' $binDir

Write-Host 'Windows tool bundle complete.'
