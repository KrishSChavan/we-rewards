# Ship to staging, then to production, in one command.
#
#   npm run ship -- -Message "what changed"
#   powershell -File scripts\ship.ps1 -Message "what changed"
#
# Runs deploy-staging.ps1, waits for the staging build to go live, then STOPS
# and asks you to test it before running promote-to-main.ps1.
#
# The stop is the point. Staging exists so that something can be wrong somewhere
# that is not in front of students, and a script that skipped straight past it
# would be a slower way of pushing to main. If you genuinely want it unattended,
# -Yes removes the pause; do that only for a change you would have been happy to
# push to main directly.
#
#   -Message      commit message. Prompted for if omitted.
#   -Yes          no pause, no confirmations. Ships to production unattended.
#   -SkipTests    skip npm test + the client build. CI still gates production.
[CmdletBinding()]
param(
    [string]$Message,
    [switch]$Yes,
    [switch]$SkipTests
)

. (Join-Path $PSScriptRoot '_deploy-lib.ps1')

Set-Location (Get-RepoRoot)
Write-Host 'Ship: STAGING then PRODUCTION' -ForegroundColor White

# THE $LASTEXITCODE CHECK IS LOAD-BEARING. `exit 1` inside a script invoked with
# `&` does NOT stop the caller — this script carries on to the next line — it
# only sets $LASTEXITCODE. Verified, not assumed. Delete the check and a failed
# staging deploy walks straight into the production promotion below.
$staging = Join-Path $PSScriptRoot 'deploy-staging.ps1'
$LASTEXITCODE = 0
& $staging -Message $Message -SkipTests:$SkipTests
if ($LASTEXITCODE -ne 0) { Fail 'Staging deploy failed. Production untouched.' }

Write-Host ''
Write-Host '--------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ' Staging is live. Test it before this goes to students.' -ForegroundColor White
Write-Host "   $script:StagingUrl" -ForegroundColor White
Write-Info 'Worth a look: sign in, earn something, open the tab you changed.'
Write-Info 'If this deploy had migrations, apply them to staging first.'
Write-Host '--------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ''

Confirm-Or-Stop -Question 'Staging looks right. Promote to production?' -Assume:$Yes

$promote = Join-Path $PSScriptRoot 'promote-to-main.ps1'
& $promote -Yes:$Yes -SkipTests:$SkipTests
