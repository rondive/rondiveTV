param(
  [string]$DockerUsername = 'ronform',
  [string]$Version = '5.8.0',
  [string]$Platforms = 'linux/arm64',
  [string[]]$Services = @('core', 'watch-room', 'db')
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

$serviceMap = @{
  core = @{
    Image = 'rondivetv-core'
    Context = '.'
    Dockerfile = 'Dockerfile'
    Build = $true
  }
  'watch-room' = @{
    Image = 'watch-room-server'
    Context = 'watch-room-server'
    Dockerfile = 'watch-room-server/Dockerfile'
    Build = $false
  }
  db = @{
    Image = 'apache/kvrocks'
    Build = $false
  }
}

$builderName = 'default'

Write-Host "Platforms: $Platforms"
Write-Host "Builder: $builderName"

docker buildx version | Out-Null

docker buildx inspect $builderName *>$null
if ($LASTEXITCODE -ne 0) {
  docker buildx create --name $builderName --driver docker-container --use | Out-Null
} else {
  docker buildx use $builderName | Out-Null
}

docker buildx inspect --bootstrap | Out-Null

foreach ($service in $Services) {
  if (-not $serviceMap.ContainsKey($service)) {
    throw "Unknown service: $service. Known: $($serviceMap.Keys -join ', ')"
  }

  $config = $serviceMap[$service]
  if (-not $config.Build) {
    Write-Host "Skipping $service (external image): $($config.Image)"
    continue
  }

  $context = $config.Context
  $dockerfile = $config.Dockerfile
  $imageTag = "$DockerUsername/$($config.Image):$Version"

  if (-not (Test-Path $dockerfile)) {
    throw "Dockerfile not found: $dockerfile"
  }
  if (-not (Test-Path $context)) {
    throw "Context not found: $context"
  }

  Write-Host "Building $service -> $imageTag"
  docker buildx build `
    --platform $Platforms `
    --file $dockerfile `
    --tag $imageTag `
    --push `
    $context
}
