<#
.SYNOPSIS
  Starts the GRAVEYARD local browser demo (Windows). Not run or verified by its author.

.DESCRIPTION
  Compiles the backend test harness, then runs the compiled GitHub e2e module directly with node in
  browser demo mode (GRAVEYARD_BROWSER_DEMO=1) for one pinned public repository: the default fixture below, or
  the operator-chosen -RepositoryUrl at -Commit. The harness builds
  its isolated Docker topology, starts the real API and worker, serves the site with Vite on
  127.0.0.1, prints the workspace URL, and waits. Ctrl+C stops Vite first, then the worker, API,
  Docker proxies, networks and temporary directories. No job is submitted for you.

.PARAMETER Port
  Browser port on 127.0.0.1 (1024-65535, default 3010). Strict: the demo fails if it is taken.

.PARAMETER RepositoryUrl
  Optional public repository to rehearse instead of the default fixture: https://github.com/<owner>/<repo>
  (a trailing .git is removed). Must be given together with -Commit. Validated like the backend and the harness.

.PARAMETER Commit
  Required with -RepositoryUrl: the full 40-character lowercase hex commit SHA you chose. Never resolved from a
  branch or HEAD. Exactly this one URL and commit become the worker's pin and the only URL the demo accepts.

.PARAMETER Check
  Runs only the read-only preflight and exits (0 ready, 1 blocked). The same preflight gates a normal launch.
  Checks: frontend Vite and backend TypeScript installed, Node >= 22.13, docker CLI and a working Linux daemon,
  local images node:22-alpine and the git image (GRAVEYARD_GITHUB_E2E_GIT_IMAGE if set, else alpine/git:2.47.2;
  an empty or invalid value is rejected like the harness does), kiro-cli on PATH. It installs, pulls, compiles, starts
  nothing and sends no model request. It cannot verify kiro-cli login.

.PARAMETER InspectPublic
  Optional. Also lets the browser submit any other public https://github.com/<owner>/<repo> URL. Those jobs use the
  worker's existing read-only unpinned intake (GRAVEYARD_GITHUB_ALLOW_UNPINNED=1): HEAD is resolved to a commit SHA and
  the root files are checked as data. Nothing from them is installed, built or run, and no model is called. The pinned
  URL is unchanged and can still be repaired. Without this switch the demo accepts only the pinned URL.
#>
[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 3010,

  [string]$RepositoryUrl,

  [string]$Commit,

  [switch]$Check,

  [switch]$InspectPublic
)

$ErrorActionPreference = 'Stop'

$FixtureUrl    = 'https://github.com/yash123443/graveyard-npm-repair-fixture'
$FixtureCommit = 'f3fe0aadbc7b62b28d583e21879ad8bb47f90751'
# The harness rejects this catalog placeholder as a supported URL, so the launcher does too.
$PlaceholderUrl = 'https://github.com/graveyard-local/unused-placeholder'

# Mirrors backend/src/url.ts validateGithubUrl (case-sensitive, ASCII only). Returns the canonical URL
# (optional trailing ".git" removed) or $null. Never echoes the input.
function ConvertTo-CanonicalGithubUrl([string]$Raw) {
  if ([string]::IsNullOrEmpty($Raw) -or $Raw.Length -gt 1024) { return $null }
  if ($Raw -cmatch '[%\\@?#\s]') { return $null }
  if ($Raw -cmatch 'https:.*:') { return $null }
  $prefix = 'https://github.com/'
  if (-not $Raw.StartsWith($prefix, [System.StringComparison]::Ordinal)) { return $null }
  $path = $Raw.Substring($prefix.Length)
  if ($path.EndsWith('.git', [System.StringComparison]::Ordinal)) { $path = $path.Substring(0, $path.Length - 4) }
  if ($path.EndsWith('/', [System.StringComparison]::Ordinal)) { return $null }
  $segments = $path.Split('/')
  if ($segments.Count -ne 2) { return $null }
  $owner = $segments[0]; $repo = $segments[1]
  if ($owner -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]*\z') { return $null }
  if ($repo -ceq '.' -or $repo -ceq '..' -or $repo -cnotmatch '^[A-Za-z0-9_.-]+\z') { return $null }
  return "$prefix$owner/$repo"
}

# Chooses the one pin. Defaults to the verified fixture. -RepositoryUrl and -Commit must come together.
$hasUrl = $PSBoundParameters.ContainsKey('RepositoryUrl')
$hasCommit = $PSBoundParameters.ContainsKey('Commit')
if ($hasUrl -ne $hasCommit) {
  Write-Host 'Pass -RepositoryUrl and -Commit together, or neither (neither uses the default fixture).' -ForegroundColor Red
  exit 1
}
if ($hasUrl) {
  $TargetUrl = ConvertTo-CanonicalGithubUrl $RepositoryUrl
  if ($null -eq $TargetUrl) {
    Write-Host '-RepositoryUrl must be a public GitHub URL of the form https://github.com/<owner>/<repo> (a trailing .git is accepted; no other path, query, port, credentials or whitespace).' -ForegroundColor Red
    exit 1
  }
  if ($Commit -cnotmatch '^[0-9a-f]{40}\z') {
    Write-Host '-Commit must be a full 40-character lowercase hexadecimal commit SHA. Branch names, tags, short SHAs and HEAD are not accepted, and the launcher never resolves them.' -ForegroundColor Red
    exit 1
  }
  if ($TargetUrl -ceq $PlaceholderUrl) {
    Write-Host '-RepositoryUrl must not be the harness placeholder URL.' -ForegroundColor Red
    exit 1
  }
  $TargetCommit = $Commit
} else {
  $TargetUrl = $FixtureUrl
  $TargetCommit = $FixtureCommit
}
$IsDefaultFixture = ($TargetUrl -ceq $FixtureUrl -and $TargetCommit -ceq $FixtureCommit)

$repoRoot = Split-Path -Parent $PSScriptRoot
$backend  = Join-Path $repoRoot 'backend'

$MinNode      = [version]'22.13.0'   # backend/package.json engines minimum
$DefaultGitImage = 'alpine/git:2.47.2'
# Same rules as the harness (manual-github-e2e-check.ts): case-sensitive, at most 255 characters.
$GitImagePattern = '^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?\z'

# Runs a native command without letting stderr or a nonzero exit become a terminating error
# (PowerShell 5.1 and 7). Returns @{ Code; Out }.
function Invoke-Native([string]$File, [string[]]$Arguments) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $File @Arguments 2>$null
    return @{ Code = $LASTEXITCODE; Out = (($out | Out-String).Trim()) }
  } catch {
    return @{ Code = -1; Out = '' }
  } finally {
    $ErrorActionPreference = $prev
  }
}

# Cheap, read-only preflight: no install, pull, build, model request or service start.
# Returns a list of actionable problems (empty when ready).
function Test-DemoPreflight {
  $problems = New-Object System.Collections.Generic.List[string]

  # The harness uses GRAVEYARD_GITHUB_E2E_GIT_IMAGE when it is set (even empty, which it rejects).
  $gitImage = [Environment]::GetEnvironmentVariable('GRAVEYARD_GITHUB_E2E_GIT_IMAGE', 'Process')
  $gitImageValid = $true
  if ($null -eq $gitImage) {
    $gitImage = $DefaultGitImage
  } elseif ($gitImage.Length -gt 255 -or $gitImage -cnotmatch $GitImagePattern) {
    $gitImageValid = $false
    $problems.Add('GRAVEYARD_GITHUB_E2E_GIT_IMAGE is set but is not a valid image reference (an empty value is invalid). Unset it to use the default, or set a valid local image.')
  }

  $vite = Join-Path $repoRoot 'node_modules/vite/bin/vite.js'
  if (-not (Test-Path $vite)) { $problems.Add("Frontend Vite is not installed ($vite missing). Run 'pnpm install' in $repoRoot.") }
  $tscPath = Join-Path $backend 'node_modules/typescript/bin/tsc'
  if (-not (Test-Path $tscPath)) { $problems.Add("Backend TypeScript compiler is not installed ($tscPath missing). Run 'pnpm install' in $backend.") }

  if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
    $problems.Add("node not found on PATH. Install Node.js $MinNode or newer.")
  } else {
    $nv = Invoke-Native 'node' @('--version')
    $parsed = $null
    if ($nv.Code -ne 0 -or -not [version]::TryParse(($nv.Out -replace '^v', ''), [ref]$parsed)) {
      $problems.Add("Could not read the Node version (node --version gave '$($nv.Out)'). Install Node.js $MinNode or newer.")
    } elseif ($parsed -lt $MinNode) {
      $problems.Add("Node $($nv.Out) is too old. The backend needs $MinNode or newer.")
    }
  }

  if (-not (Get-Command docker -CommandType Application -ErrorAction SilentlyContinue)) {
    $problems.Add('docker not found on PATH. Install Docker Desktop.')
  } else {
    $dv = Invoke-Native 'docker' @('version', '--format', '{{.Server.Os}}')
    if ($dv.Code -ne 0) {
      $problems.Add('The Docker daemon is not reachable. Start Docker Desktop and wait until it is running (this script does not start it).')
    } elseif ($dv.Out -ne 'linux') {
      $problems.Add("Docker is using '$($dv.Out)' containers. Switch Docker Desktop to Linux containers.")
    } else {
      $images = @('node:22-alpine')
      if ($gitImageValid) { $images += $gitImage }
      foreach ($img in ($images | Select-Object -Unique)) {
        $ii = Invoke-Native 'docker' @('image', 'inspect', '--format', '{{.Id}}', $img)
        if ($ii.Code -ne 0) { $problems.Add("Local Docker image missing: $img. Run 'docker pull $img' yourself (this script never pulls).") }
      }
    }
  }

  if (-not (Get-Command 'kiro-cli' -CommandType Application -ErrorAction SilentlyContinue)) {
    $problems.Add('kiro-cli not found on PATH. Install Kiro CLI and open a new terminal so PATH refreshes.')
  }
  return ,$problems
}

$problems = Test-DemoPreflight
if ($problems.Count -gt 0) {
  Write-Host 'Demo preflight FAILED:' -ForegroundColor Red
  foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
  exit 1
}
if ($Check) {
  Write-Host 'Preflight passed: Vite, backend compiler, Node, Docker (Linux daemon), local images and kiro-cli are present.' -ForegroundColor Green
  Write-Host 'Caveat: this does not check that kiro-cli is logged in, and it does not prove a real repair. Confirm login and a verified repair in a rehearsal run.'
  exit 0
}

$vars = 'GRAVEYARD_MANUAL_GITHUB_E2E', 'GRAVEYARD_GITHUB_E2E_NPM_REPAIR', 'GRAVEYARD_GITHUB_E2E_SUPPORTED_URL',
        'GRAVEYARD_GITHUB_E2E_SUPPORTED_COMMIT', 'GRAVEYARD_GITHUB_E2E_STATIC', 'GRAVEYARD_BROWSER_DEMO', 'GRAVEYARD_DEMO_PORT',
        'GRAVEYARD_DEMO_INSPECT_PUBLIC'
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
  $env:GRAVEYARD_GITHUB_E2E_SUPPORTED_URL    = $TargetUrl
  $env:GRAVEYARD_GITHUB_E2E_SUPPORTED_COMMIT = $TargetCommit
  $env:GRAVEYARD_BROWSER_DEMO                = '1'
  $env:GRAVEYARD_DEMO_PORT                   = [string]$Port
  Remove-Item Env:GRAVEYARD_GITHUB_E2E_STATIC -ErrorAction SilentlyContinue
  if ($InspectPublic) {
    $env:GRAVEYARD_DEMO_INSPECT_PUBLIC = '1'
    Write-Host 'Public inspection is on: any other public https://github.com/<owner>/<repo> URL is inspected read-only at its current HEAD (resolved commit and root-file findings). Nothing from it is installed, built or run and none of its source is sent to Kiro. Only the pinned URL can be repaired.' -ForegroundColor Yellow
  } else {
    Remove-Item Env:GRAVEYARD_DEMO_INSPECT_PUBLIC -ErrorAction SilentlyContinue
  }

  if (-not $IsDefaultFixture) {
    Write-Host 'Rehearsal with an operator-chosen repository. Submitting a job sends its bounded build-entry source to live Kiro. Support is not verified for it; if it is outside the narrow supported class it ends as unsupported-repository or repository-failing without a verified repair.' -ForegroundColor Yellow
  }
  Write-Host "Starting demo for $TargetUrl @ $TargetCommit. Setup takes a while; the URL is printed when ready. Ctrl+C to stop."
  & node 'dist-test/test/manual-github-e2e-check.js'
  $code = $LASTEXITCODE
}
finally {
  Pop-Location
  foreach ($v in $vars) { [Environment]::SetEnvironmentVariable($v, $saved[$v], 'Process') }
}
exit $code
