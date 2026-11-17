<#
.SYNOPSIS
  Starts the GRAVEYARD local browser demo (Windows). Not run or verified by its author.

.DESCRIPTION
  Compiles the backend test harness, then runs the compiled GitHub e2e module directly with node in
  browser demo mode (GRAVEYARD_BROWSER_DEMO=1) for the pinned public fixture below. The harness builds
  its isolated Docker topology, starts the real API and worker, serves the site with Vite on
  127.0.0.1, prints the workspace URL, and waits. Ctrl+C stops Vite first, then the worker, API,
  Docker proxies, networks and temporary directories. No job is submitted for you.

.PARAMETER Port
  Browser port on 127.0.0.1 (1024-65535, default 3010). Strict: the demo fails if it is taken.
#>
[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 3010
)

$ErrorActionPreference = 'Stop'

$FixtureUrl    = 'https://github.com/yash123443/graveyard-npm-repair-fixture'
$FixtureCommit = 'f3fe0aadbc7b62b28d583e21879ad8bb47f90751'

$repoRoot = Split-Path -Parent $PSScriptRoot
$backend  = Join-Path $repoRoot 'backend'

foreach ($tool in 'node', 'docker') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required tool not found on PATH: $tool" }
}
foreach ($dir in $repoRoot, $backend) {
  if (-not (Test-Path (Join-Path $dir 'node_modules'))) { throw "Dependencies are not installed in $dir. Run: pnpm install" }
}

$vars = 'GRAVEYARD_MANUAL_GITHUB_E2E', 'GRAVEYARD_GITHUB_E2E_NPM_REPAIR', 'GRAVEYARD_GITHUB_E2E_SUPPORTED_URL',
        'GRAVEYARD_GITHUB_E2E_SUPPORTED_COMMIT', 'GRAVEYARD_GITHUB_E2E_STATIC', 'GRAVEYARD_BROWSER_DEMO', 'GRAVEYARD_DEMO_PORT'
$saved = @{}
foreach ($v in $vars) { $saved[$v] = [Environment]::GetEnvironmentVariable($v, 'Process') }

Push-Location $backend
try {
  $tsc = Join-Path $backend 'node_modules/typescript/bin/tsc'
  if (-not (Test-Path $tsc)) {
    throw "TypeScript compiler not found at $tsc. Install the backend dependencies first (run 'pnpm install' in $backend), then retry."
  }
  & node 'node_modules/typescript/bin/tsc' -p 'tsconfig.test.json'
  if ($LASTEXITCODE -ne 0) { throw "tsc -p tsconfig.test.json failed with exit code $LASTEXITCODE" }

  $env:GRAVEYARD_MANUAL_GITHUB_E2E           = '1'
  $env:GRAVEYARD_GITHUB_E2E_NPM_REPAIR       = '1'
  $env:GRAVEYARD_GITHUB_E2E_SUPPORTED_URL    = $FixtureUrl
  $env:GRAVEYARD_GITHUB_E2E_SUPPORTED_COMMIT = $FixtureCommit
  $env:GRAVEYARD_BROWSER_DEMO                = '1'
  $env:GRAVEYARD_DEMO_PORT                   = [string]$Port
  Remove-Item Env:GRAVEYARD_GITHUB_E2E_STATIC -ErrorAction SilentlyContinue

  Write-Host "Starting demo for $FixtureUrl @ $FixtureCommit. Setup takes a while; the URL is printed when ready. Ctrl+C to stop."
  & node 'dist-test/test/manual-github-e2e-check.js'
  $code = $LASTEXITCODE
}
finally {
  Pop-Location
  foreach ($v in $vars) { [Environment]::SetEnvironmentVariable($v, $saved[$v], 'Process') }
}
exit $code
