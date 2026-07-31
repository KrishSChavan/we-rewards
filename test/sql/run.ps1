# Migration harness. There is no local DB, so a migration is verified by
# building a throwaway postgres:16 from schema.sql + every migration in order,
# seeding realistic data, applying the migration under test, and asserting.
#
#   powershell -File test/sql/run.ps1
#   powershell -File test/sql/run.ps1 -Keep      # leave the container up to poke at
#
# Docker is on the PowerShell PATH, not Git Bash. Nothing here touches a real
# database; the container is created and destroyed per run.
#
# WHAT IT PROVES (see behavior.sql for the assertions):
#   - migration-029 applies cleanly on top of the real schema + 002-028
#   - the punch_cards collapse conserves totals and credits outstanding cards
#   - minting re-verifies server-side and never spends
#   - burning resets to 0, records the forfeit, and rolls back on a lost race
#   - undo ADDS punches back, so one earned in between survives
#   - the points path is byte-for-byte unchanged
#
# The JS suite in test/integration/ covers the same ground through PostgREST,
# but needs a real Supabase (TEST_SUPABASE_URL) and is skipped without one.

# -Migration is the file UNDER TEST. Everything before it is applied first, then
# seed.sql populates the pre-migration world, then the migration runs against
# that data. Seeding after it would insert into columns it has already dropped.
param([string]$Migration = 'migration-029.sql', [switch]$Keep)

# Deliberately NOT ErrorActionPreference='Stop': native tools write to stderr
# routinely (docker rm on a container that isn't there, pg_isready while the
# server is still booting) and Stop turns each of those into a fatal error.
# Failures are checked explicitly instead, via $LASTEXITCODE and Fail().
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$supa = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'supabase'
$name = 'pgtest-migrations'

function Drop { if (docker ps -a --filter "name=^/$name$" --format '{{.Names}}') { docker rm -f $name | Out-Null } }
function Fail($msg) { Write-Output "FAILED: $msg"; if (-not $Keep) { Drop }; exit 1 }

Drop
docker run -d --name $name -e POSTGRES_PASSWORD=pw postgres:16 | Out-Null

$up = $false
foreach ($i in 1..40) {
  docker exec $name pg_isready -U postgres -q 2>$null
  if ($?) { $up = $true; break }
  Start-Sleep -Milliseconds 700
}
if (-not $up) { Fail 'postgres never accepted connections' }

foreach ($f in @('bootstrap.sql', 'seed.sql', 'behavior.sql', 'checks.sql')) {
  docker cp (Join-Path $here $f) "${name}:/tmp/$f" | Out-Null
}
Get-ChildItem "$supa\*.sql" | ForEach-Object { docker cp $_.FullName "${name}:/tmp/$($_.Name)" | Out-Null }

docker exec $name psql -U postgres -q -c 'create database t;' | Out-Null
$psql = { param($f) docker exec $name psql -U postgres -d t -q -v ON_ERROR_STOP=1 -f "/tmp/$f" 2>$null | Out-Null }

& $psql 'bootstrap.sql'; if ($LASTEXITCODE -ne 0) { Fail 'bootstrap (Supabase stubs)' }

# schema.sql is the baseline; migrations are numbered from 002 with no gaps.
$all = Get-ChildItem "$supa\migration-*.sql" | Sort-Object Name | Select-Object -ExpandProperty Name
if ($all -notcontains $Migration) { Fail "no such migration: $Migration" }
$before = $all | Where-Object { $_ -lt $Migration }

foreach ($f in @('schema.sql') + $before) {
  & $psql $f
  if ($LASTEXITCODE -ne 0) { Fail "applying $f" }
}
Write-Output "applied schema.sql + $($before.Count) migrations (up to but not including $Migration)"

# Populate the PRE-migration world, so the migration runs against real data.
& $psql 'seed.sql'; if ($LASTEXITCODE -ne 0) { Fail 'seeding' }

& $psql $Migration; if ($LASTEXITCODE -ne 0) { Fail "applying $Migration" }
Write-Output "applied $Migration"

# Anything numbered after it, so the whole chain still composes.
foreach ($f in ($all | Where-Object { $_ -gt $Migration })) {
  & $psql $f
  if ($LASTEXITCODE -ne 0) { Fail "applying $f (after $Migration)" }
}

$out = docker exec $name psql -U postgres -d t -X -P pager=off -f /tmp/behavior.sql 2>&1
$lines = $out -split "`n" | Select-String -Pattern 'PASS |FAIL |ERROR' |
  ForEach-Object { ($_ -replace '^.*NOTICE:\s+', '').Trim() }
$lines | ForEach-Object { Write-Output $_ }

$failed = @($lines | Where-Object { $_ -match '^(FAIL|ERROR)' })
if ($failed.Count -gt 0) { Fail "$($failed.Count) assertion(s)" }

Write-Output ""
Write-Output "ALL $($lines.Count) ASSERTIONS PASSED"
if ($Keep) {
  Write-Output "container '$name' left running: docker exec -it $name psql -U postgres -d t"
} else {
  Drop
}
