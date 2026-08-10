# Shared helpers for the deploy scripts. Dot-sourced, never run directly.
#
#   scripts\deploy-staging.ps1     staging branch  -> we-rewards-staging
#   scripts\promote-to-main.ps1    staging -> main -> we-rewards (production)
#   scripts\ship.ps1               both, with a stop in between to test staging
#
# HOW DEPLOYS ACTUALLY HAPPEN HERE. Nothing below pushes to Heroku. Both apps
# are wired to this GitHub repo with automatic deploys: a push to `staging`
# builds we-rewards-staging, a push to `main` builds we-rewards. So a deploy IS
# a git push, and these scripts are the checks around one.
#
# Deliberately NOT $ErrorActionPreference = 'Stop'. git and heroku write to
# stderr in normal operation (push progress, "Fetching..."), and Stop turns each
# of those into a fatal error. Every step checks $LASTEXITCODE instead. Same
# reasoning as test\sql\run.ps1.

# NEVER let git open a pager. `git log` and `git diff` page when stdout is a
# terminal, and a pager takes the keyboard: the next thing you type goes to
# `less`, not to the script's prompt. That is not theoretical — typing APPLIED
# at the production gate landed in less as a filename ("APPLIED: No such file or
# directory"), and the deploy aborted.
#
# Belt and braces on purpose. GIT_PAGER covers every git call in these scripts,
# including ones added later by someone who doesn't know this comment exists;
# the explicit --no-pager on each display command says so at the call site.
$env:GIT_PAGER = 'cat'

$script:StagingApp = 'we-rewards-staging'
$script:ProdApp    = 'we-rewards'
$script:StagingUrl = 'https://we-rewards-staging-d6e9af355d07.herokuapp.com'
# The custom domain, not the herokuapp one: it is what students actually hit, so
# checking it also proves Cloudflare in front of the app is serving the new build.
$script:ProdUrl    = 'https://we-rewards.com'

# The CLI cannot talk to production at all — `supabase projects list` from this
# machine does not include it (it lives in the school org; see mds\prod-transfer.md),
# which is why production migrations are pasted into the SQL editor by hand.
$script:StagingRef = 'btjzpvuneuoqcmrmoxwc'
# Pinned: 2.112.0 and later fail to link ANY project (SchemaError on api-keys),
# and a failed link clears the link you already had.
$script:SupabaseCli = 'supabase@2.111.0'

function Write-Step { param([string]$Text) Write-Host "`n=== $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  OK  $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "  !!  $Text" -ForegroundColor Yellow }
function Write-Info { param([string]$Text) Write-Host "      $Text" -ForegroundColor DarkGray }

function Fail {
    param([string]$Text)
    Write-Host "`nSTOPPED: $Text" -ForegroundColor Red
    exit 1
}

# Confirm interactively unless -Yes was passed. Anything other than y/yes stops.
function Confirm-Or-Stop {
    param([string]$Question, [switch]$Assume)
    if ($Assume) { Write-Info "(-Yes) $Question"; return }
    $answer = Read-Host "$Question [y/N]"
    if ($answer -notmatch '^(y|yes)$') { Fail 'Cancelled.' }
}

function Get-RepoRoot {
    $root = & git rev-parse --show-toplevel
    if ($LASTEXITCODE -ne 0) { Fail 'Not inside a git repository.' }
    return $root.Trim()
}

function Get-CurrentBranch {
    $b = & git rev-parse --abbrev-ref HEAD
    if ($LASTEXITCODE -ne 0) { Fail 'Could not read the current branch.' }
    return $b.Trim()
}

function Test-TreeDirty {
    $out = & git status --porcelain
    return -not [string]::IsNullOrWhiteSpace(($out -join ''))
}

# The one check that cannot be skipped. .gitignore already covers these, but a
# committed service-role key is not something you can take back — it is in the
# push, in every clone, and in GitHub's history.
function Assert-NoSecretsTracked {
    Write-Step 'Checking no secrets are tracked'
    $tracked = & git ls-files
    if ($LASTEXITCODE -ne 0) { Fail 'git ls-files failed.' }
    $bad = @($tracked | Where-Object { $_ -match '(^|/)\.env($|\.)' -and $_ -notmatch '\.env\.example$' })
    if ($bad.Count -gt 0) {
        Fail ("These files hold credentials and are tracked by git: " + ($bad -join ', ') +
              ". Run `git rm --cached <file>` and rotate the keys before deploying.")
    }
    Write-Ok 'No .env file is tracked'
}

function Invoke-PreflightChecks {
    param([switch]$SkipTests)

    if ($SkipTests) {
        Write-Warn 'Tests skipped (-SkipTests). CI still runs them; production will not deploy if they fail.'
        return
    }

    Write-Step 'Running tests'
    & npm test --silent
    if ($LASTEXITCODE -ne 0) { Fail 'Tests failed. Nothing was pushed.' }
    Write-Ok 'Tests passed'

    # The client bundles are rebuilt on the dyno at boot. A file that esbuild
    # cannot parse takes the whole app down at startup with a crashed dyno, and
    # `npm test` never touches public/ — so this is the only thing standing
    # between a typo in app.js and a white screen in production.
    #
    # check-client.js, NOT buildClientAssets(): the real build deletes and
    # rewrites .build/, which a running `npm run dev` also owns, and the two
    # race into a bogus ENOENT. See the header of scripts\check-client.js. This
    # transforms in memory and writes nothing.
    Write-Step 'Checking public/ still compiles'
    & node scripts/check-client.js
    if ($LASTEXITCODE -ne 0) { Fail 'Client code will not build. Nothing was pushed.' }
    Write-Ok 'Client code parses and lowers cleanly'
}

# Migration files this push would ADD, and any already-shipped ones it EDITS.
# Both matter and they mean different things, so they are reported separately.
function Get-MigrationChanges {
    param([string]$FromRef, [string]$ToRef)

    $added = @(& git --no-pager diff --name-only --diff-filter=A $FromRef $ToRef -- supabase/migrations)
    $edited = @(& git --no-pager diff --name-only --diff-filter=M $FromRef $ToRef -- supabase/migrations)
    return [pscustomobject]@{
        Added  = @($added | Where-Object { $_ -match '\.sql$' })
        Edited = @($edited | Where-Object { $_ -match '\.sql$' })
    }
}

function Show-MigrationWarning {
    param($Changes, [string]$Environment)

    if ($Changes.Added.Count -eq 0 -and $Changes.Edited.Count -eq 0) {
        Write-Ok 'No migration changes in this deploy'
        return $false
    }

    Write-Host ''
    Write-Warn "This deploy changes the database schema. The code will 500 until $Environment has it."
    foreach ($m in $Changes.Added)  { Write-Host "        new:    $m" -ForegroundColor Yellow }
    foreach ($m in $Changes.Edited) {
        Write-Host "        EDITED: $m" -ForegroundColor Red
        Write-Info 'An edited migration will NOT re-run by itself. Apply the change by hand.'
    }
    return $true
}

function Get-HerokuRelease {
    param([string]$App)
    $raw = & heroku releases -a $App --json -n 1
    if ($LASTEXITCODE -ne 0) { return $null }
    try { return (($raw -join '') | ConvertFrom-Json)[0] } catch { return $null }
}

# Heroku names a build after the commit it came from ("Deploy 916d1ec3"), which
# is a far better signal than an asset hash: this repo has core.autocrlf=true, so
# a file checked out on Linux is byte-for-byte different from the same file here
# and any locally-computed content hash would never match what the dyno serves.
function Wait-ForDeploy {
    param([string]$App, [string]$Sha, [int]$TimeoutSeconds = 420, [string]$Label = 'deploy')

    Write-Step "Waiting for the $Label of $Sha"
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastSeen = ''

    while ((Get-Date) -lt $deadline) {
        $rel = Get-HerokuRelease -App $App
        if ($rel) {
            $desc = [string]$rel.description
            $m = [regex]::Match($desc, '[0-9a-f]{7,40}')
            if ($m.Success) {
                $deployed = $m.Value
                # Compare by prefix: heroku's short sha and git's may differ in length.
                $matches = $Sha.StartsWith($deployed) -or $deployed.StartsWith($Sha)
                if ($matches -and $rel.status -eq 'succeeded') {
                    Write-Ok "v$($rel.version) is live ($desc)"
                    return $true
                }
                if ($matches -and $rel.status -eq 'failed') {
                    Fail "The build for $Sha FAILED on $App. Run: heroku logs -a $App --source app --tail"
                }
            }
            if ($desc -ne $lastSeen) {
                Write-Info "current release: v$($rel.version) $desc [$($rel.status)]"
                $lastSeen = $desc
            }
        }
        Start-Sleep -Seconds 10
    }

    Write-Warn "Gave up waiting after $TimeoutSeconds seconds. The build may still be running."
    Write-Info "Check it with:  heroku releases -a $App"
    return $false
}

function Test-Health {
    param([string]$Url)
    Write-Step "Health check $Url/api/health"
    try {
        $r = Invoke-WebRequest -Uri "$Url/api/health" -TimeoutSec 30 -UseBasicParsing
        if ($r.StatusCode -eq 200 -and $r.Content -match '"ok"\s*:\s*true') {
            Write-Ok 'Responding'
            return $true
        }
        Write-Warn "Unexpected response: $($r.StatusCode) $($r.Content)"
        return $false
    } catch {
        Write-Warn "Not responding: $($_.Exception.Message)"
        return $false
    }
}
