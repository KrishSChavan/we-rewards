# Ship the working tree to STAGING.
#
#   npm run deploy:staging -- -Message "what changed"
#   powershell -File scripts\deploy-staging.ps1 -Message "what changed"
#
# Commits whatever is in the working tree onto the `staging` branch and pushes
# it. Heroku's GitHub integration builds we-rewards-staging from that push; this
# script then waits until the release naming your commit is live, so when it
# says "done" the code really is running.
#
# Touches nothing in production. `main` is not read, written, or pushed.
#
#   -Message      commit message. Prompted for if omitted.
#   -SkipTests    skip npm test + the client build. CI still runs the tests.
#   -NoWait       push and exit instead of waiting for the build.
#   -DryRun       run every check and print what would ship, then stop. Changes
#                 no branch, makes no commit, pushes nothing.
[CmdletBinding()]
param(
    [string]$Message,
    [switch]$SkipTests,
    [switch]$NoWait,
    [switch]$DryRun
)

. (Join-Path $PSScriptRoot '_deploy-lib.ps1')

Set-Location (Get-RepoRoot)
Write-Host 'Deploy to STAGING' -ForegroundColor White

Assert-NoSecretsTracked

# ---------- get onto the staging branch, carrying the working tree ----------

Write-Step 'Preparing the staging branch'
$branch = Get-CurrentBranch

if ($DryRun) {
    Write-Warn 'DRY RUN: nothing will be committed, switched, or pushed.'
    Write-Info "current branch: $branch, working tree dirty: $(Test-TreeDirty)"
    Invoke-PreflightChecks -SkipTests:$SkipTests
    Write-Step 'Files that would be committed'
    & git status --short
    Write-Step 'Migration changes this would carry to staging'
    # Untracked files are invisible to `git diff`, so ask the index-and-worktree
    # view instead: before the commit, a brand new migration is untracked.
    $pending = @(& git status --porcelain -- supabase/migrations | ForEach-Object { $_.Substring(3) })
    if ($pending.Count -eq 0) { Write-Ok 'None' }
    else { foreach ($m in $pending) { Write-Host "        $m" -ForegroundColor Yellow } }
    Write-Host "`nDRY RUN COMPLETE. Nothing changed." -ForegroundColor White
    exit 0
}

if ($branch -ne 'staging') {
    # Uncommitted work follows a checkout only when the two branches agree about
    # every file it touches. They normally do here (main is a fast-forward of
    # staging), but if main has commits staging lacks, a checkout would silently
    # leave them behind and deploy the wrong thing — so refuse instead.
    $ahead = & git rev-list --count staging..$branch
    if ($LASTEXITCODE -ne 0) { Fail "Could not compare $branch with staging." }
    if ([int]$ahead.Trim() -gt 0) {
        Fail ("$branch has $($ahead.Trim()) commit(s) that staging does not, so switching " +
              "branches would leave them behind. The flow in mds\staging-setup.md is to work " +
              "on staging. To bring them across: git checkout staging; git merge $branch")
    }
    Write-Info "switching from $branch to staging"
    & git checkout staging
    if ($LASTEXITCODE -ne 0) { Fail 'Could not switch to the staging branch (uncommitted changes may conflict).' }
}

& git fetch origin staging --quiet
if ($LASTEXITCODE -eq 0) {
    $behind = & git rev-list --count staging..origin/staging
    if ($LASTEXITCODE -eq 0 -and [int]$behind.Trim() -gt 0) {
        Write-Info "staging is $($behind.Trim()) commit(s) behind origin; fast-forwarding"
        & git merge --ff-only origin/staging
        if ($LASTEXITCODE -ne 0) { Fail 'staging has diverged from origin/staging. Reconcile it by hand.' }
    }
}
Write-Ok 'On staging, up to date with origin'

# ---------- checks ----------

Invoke-PreflightChecks -SkipTests:$SkipTests

# ---------- commit ----------

Write-Step 'Committing'
if (Test-TreeDirty) {
    & git status --short
    if ([string]::IsNullOrWhiteSpace($Message)) {
        $Message = Read-Host "`nCommit message"
        if ([string]::IsNullOrWhiteSpace($Message)) { Fail 'A commit message is required.' }
    }
    & git add -A
    if ($LASTEXITCODE -ne 0) { Fail 'git add failed.' }
    & git commit -m $Message
    if ($LASTEXITCODE -ne 0) { Fail 'git commit failed.' }
    Write-Ok 'Committed'
} else {
    Write-Info 'Nothing to commit'
    $unpushed = & git rev-list --count origin/staging..staging
    if ($LASTEXITCODE -eq 0 -and [int]$unpushed.Trim() -eq 0) {
        Write-Ok 'staging already matches origin. Nothing to deploy.'
        exit 0
    }
    Write-Info "$($unpushed.Trim()) commit(s) already committed but not pushed"
}

# ---------- what this deploy carries ----------

Write-Step 'What this deploy carries'
& git --no-pager log origin/staging..staging --oneline
$migrations = Get-MigrationChanges -FromRef 'origin/staging' -ToRef 'staging'
$hasMigrations = Show-MigrationWarning -Changes $migrations -Environment 'staging'

if ($hasMigrations) {
    Write-Host ''
    Write-Info 'Apply them to staging after the push (the CLI is linked to staging):'
    Write-Info "  npx $script:SupabaseCli projects list      # confirm the * is on we-rewards-staging"
    Write-Info "  npx $script:SupabaseCli db push"
    Write-Info 'The link is sticky, so check it every time rather than assuming.'
}

# ---------- push ----------

$sha = (& git rev-parse --short=8 HEAD).Trim()
$before = Get-HerokuRelease -App $script:StagingApp
if ($before) { Write-Info "staging is currently on v$($before.version) ($($before.description))" }

Write-Step "Pushing $sha to origin/staging"
& git push origin staging
if ($LASTEXITCODE -ne 0) { Fail 'git push failed. Nothing was deployed.' }
Write-Ok 'Pushed'

if ($NoWait) {
    Write-Host "`nPushed. Heroku is building. Watch it with: heroku releases -a $script:StagingApp" -ForegroundColor White
    exit 0
}

$live = Wait-ForDeploy -App $script:StagingApp -Sha $sha -TimeoutSeconds 420 -Label 'staging build'
if ($live) { [void](Test-Health -Url $script:StagingUrl) }

# ---------- what to do next ----------

Write-Host ''
Write-Host 'STAGING IS UPDATED' -ForegroundColor Green
Write-Host "  $script:StagingUrl" -ForegroundColor White
if ($hasMigrations) {
    Write-Host '  Apply the migrations above before testing, or the new features will 500.' -ForegroundColor Yellow
}
Write-Info 'The installed TEST app picks this up without a CACHE bump (serveTestSw stamps a content hash).'
Write-Info 'When it looks right:  npm run deploy:prod'
