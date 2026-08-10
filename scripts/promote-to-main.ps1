# Promote what is on STAGING to PRODUCTION.
#
#   npm run deploy:prod
#   powershell -File scripts\promote-to-main.ps1
#
# Merges `staging` into `main` and pushes. Heroku builds we-rewards from that
# push, gated on CI going green, so the release can take several minutes to
# appear. This script waits for it and then checks we-rewards.com.
#
# It ships EXACTLY what is on origin/staging and nothing else. It refuses to run
# with uncommitted changes or with unpushed local commits, because anything not
# on origin/staging is by definition something you have not tested on staging.
#
#   -Yes          skip the confirmations. For a repeat of a deploy you have
#                 already reasoned about; it does not skip any of the checks.
#   -SkipTests    skip npm test + the client build locally. CI still gates the deploy.
#   -NoWait       push and exit instead of waiting for the build.
#   -DryRun       show exactly what would ship, including the migrations, then
#                 stop. Merges nothing, pushes nothing.
[CmdletBinding()]
param(
    [switch]$Yes,
    [switch]$SkipTests,
    [switch]$NoWait,
    [switch]$DryRun
)

. (Join-Path $PSScriptRoot '_deploy-lib.ps1')

Set-Location (Get-RepoRoot)
Write-Host 'Promote STAGING -> PRODUCTION' -ForegroundColor White

Assert-NoSecretsTracked

# ---------- refuse to ship anything staging has not seen ----------

Write-Step 'Checking staging is the thing you tested'

if (Test-TreeDirty) {
    & git status --short
    Fail 'You have uncommitted changes. Ship them to staging first: npm run deploy:staging'
}

& git fetch origin --quiet
if ($LASTEXITCODE -ne 0) { Fail 'git fetch failed.' }

$unpushed = & git rev-list --count origin/staging..staging
if ($LASTEXITCODE -ne 0) { Fail 'Could not compare staging with origin/staging.' }
if ([int]$unpushed.Trim() -gt 0) {
    Fail ("Local staging has $($unpushed.Trim()) commit(s) that origin does not, so they were never " +
          'built or tested on the staging app. Run: npm run deploy:staging')
}
Write-Ok 'origin/staging is what has been running on the staging app'

$pending = & git rev-list --count origin/main..origin/staging
if ($LASTEXITCODE -ne 0) { Fail 'Could not compare main with staging.' }
if ([int]$pending.Trim() -eq 0) {
    Write-Ok 'Production already has everything on staging. Nothing to promote.'
    exit 0
}

# ---------- show exactly what ships ----------

Write-Step "Promoting $($pending.Trim()) commit(s) to production"
& git log origin/main..origin/staging --oneline
Write-Host ''
& git diff --stat origin/main origin/staging

# ---------- migrations: the thing that breaks production quietly ----------

$migrations = Get-MigrationChanges -FromRef 'origin/main' -ToRef 'origin/staging'
$hasMigrations = Show-MigrationWarning -Changes $migrations -Environment 'production'

if ($DryRun) {
    Write-Host "`nDRY RUN COMPLETE. Nothing was merged or pushed." -ForegroundColor White
    exit 0
}

if ($hasMigrations) {
    Write-Host ''
    Write-Host '  PRODUCTION MIGRATIONS ARE APPLIED BY HAND.' -ForegroundColor Yellow
    Write-Info 'The Supabase CLI cannot reach the production project from this machine'
    Write-Info '(it lives in the school org - see mds\prod-transfer.md), so `db push` is not'
    Write-Info 'an option. Open the production project in the Supabase dashboard, go to the'
    Write-Info 'SQL Editor, and paste each file above IN ORDER, top to bottom.'
    Write-Info ''
    Write-Info 'Do it BEFORE pushing. The window between a deploy and its migration is a'
    Write-Info 'window where students get errors: migration 039 alone gates /api/me/history'
    Write-Info 'and /api/me/export, which every student hits.'
    Write-Host ''

    if (-not $Yes) {
        $typed = Read-Host 'Type APPLIED once every migration above is in the production database'
        if ($typed -ne 'APPLIED') { Fail 'Cancelled. Apply the migrations, then run this again.' }
    } else {
        Write-Warn '(-Yes) Assuming the migrations above are already applied to production.'
    }
}

# ---------- checks ----------

Invoke-PreflightChecks -SkipTests:$SkipTests

# ---------- confirm ----------

Write-Host ''
Confirm-Or-Stop -Question "Deploy to PRODUCTION ($script:ProdUrl)?" -Assume:$Yes

# ---------- merge and push ----------

$startBranch = Get-CurrentBranch

Write-Step 'Merging staging into main'
& git checkout main
if ($LASTEXITCODE -ne 0) { Fail 'Could not switch to main.' }

& git merge --ff-only origin/main
if ($LASTEXITCODE -ne 0) { Fail 'Local main has diverged from origin/main. Reconcile it by hand.' }

# --ff-only on purpose: in this workflow main is always an ancestor of staging,
# so a fast-forward is the honest outcome. If it is not, something happened on
# main that never went through staging, and that deserves a human rather than an
# automatic merge commit.
& git merge --ff-only origin/staging
if ($LASTEXITCODE -ne 0) {
    & git checkout $startBranch
    Fail ('main could not be fast-forwarded to staging, which means main has commits staging ' +
          'does not. Reconcile them by hand (git log origin/staging..origin/main) before promoting.')
}
Write-Ok 'main fast-forwarded to staging'

$sha = (& git rev-parse --short=8 HEAD).Trim()
$before = Get-HerokuRelease -App $script:ProdApp
if ($before) { Write-Info "production is currently on v$($before.version) ($($before.description))" }

Write-Step "Pushing $sha to origin/main"
& git push origin main
if ($LASTEXITCODE -ne 0) {
    & git checkout $startBranch
    Fail 'git push failed. Production is unchanged.'
}
Write-Ok 'Pushed'

# Back to staging straight away so the next edit lands in the right place. The
# runbook's loop ends this way for the same reason.
& git checkout staging
if ($LASTEXITCODE -ne 0) { Write-Warn "Could not switch back to staging; you are on $(Get-CurrentBranch)." }

if ($NoWait) {
    Write-Host "`nPushed. CI must pass before Heroku builds. Watch: heroku releases -a $script:ProdApp" -ForegroundColor White
    exit 0
}

# Longer than staging: production waits for CI to go green before it builds at
# all (mds\staging-setup.md step 10), so the release appears minutes after the push.
Write-Info 'Production waits for CI before building, so this takes a few minutes.'
$live = Wait-ForDeploy -App $script:ProdApp -Sha $sha -TimeoutSeconds 900 -Label 'production build'
if ($live) { [void](Test-Health -Url $script:ProdUrl) }

Write-Host ''
Write-Host 'PRODUCTION IS UPDATED' -ForegroundColor Green
Write-Host "  $script:ProdUrl" -ForegroundColor White
Write-Info 'Installed student/vendor PWAs only pick up shell changes on a CACHE bump in sw.js.'
Write-Info "Rollback:  heroku rollback -a $script:ProdApp"
