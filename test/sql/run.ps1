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
# the seed populates the pre-migration world, then the migration runs against
# that data. Seeding after it would insert into columns it has already dropped.
#
# -Seed / -Behavior pair with the migration: the defaults describe the world
# migration-029 had to survive, which later migrations then dismantle (030 drops
# the punch-card columns the default seed writes). A new migration brings its own
# pair, e.g.
#   powershell -File test/sql/run.ps1 -Migration migration-032.sql `
#              -Seed seed-032.sql -Behavior behavior-032.sql
param(
  [string]$Migration = 'migration-029.sql',
  [string]$Seed = 'seed.sql',
  [string]$Behavior = 'behavior.sql',
  [switch]$Keep
)

# Deliberately NOT ErrorActionPreference='Stop': native tools write to stderr
# routinely (docker rm on a container that isn't there, pg_isready while the
# server is still booting) and Stop turns each of those into a fatal error.
# Failures are checked explicitly instead, via $LASTEXITCODE and Fail().
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# The SQL now lives in supabase\migrations\ with the CLI's numeric prefixes
# (00000000000001_schema.sql, 00000000000029_migration-029.sql, ...). The
# numeric prefix makes plain name sorting the application order, schema first.
# Join-Path twice rather than one 'supabase\migrations' literal: a backslash is
# an ordinary character in a path on macOS, not a separator, so the one-string
# form built a directory literally named "supabase\migrations" and every
# migration silently went missing. Same reason the two globs below are joined.
$supa = Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'supabase') 'migrations'
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

foreach ($f in (@('bootstrap.sql', 'checks.sql', $Seed, $Behavior) | Select-Object -Unique)) {
  docker cp (Join-Path $here $f) "${name}:/tmp/$f" | Out-Null
}
Get-ChildItem (Join-Path $supa '*.sql') | ForEach-Object { docker cp $_.FullName "${name}:/tmp/$($_.Name)" | Out-Null }

docker exec $name psql -U postgres -q -c 'create database t;' | Out-Null
$psql = { param($f) docker exec $name psql -U postgres -d t -q -v ON_ERROR_STOP=1 -f "/tmp/$f" 2>$null | Out-Null }

& $psql 'bootstrap.sql'; if ($LASTEXITCODE -ne 0) { Fail 'bootstrap (Supabase stubs)' }

# -Migration still takes the short 'migration-NNN.sql' form; resolve it to the
# prefixed on-disk name. (A full prefixed name is accepted too.)
$all = Get-ChildItem (Join-Path $supa '*.sql') | Sort-Object Name | Select-Object -ExpandProperty Name
if ($all -notcontains $Migration) {
  $resolved = @($all | Where-Object { $_ -like "*_$Migration" })
  if ($resolved.Count -ne 1) { Fail "no such migration: $Migration" }
  $Migration = $resolved[0]
}
# Everything that sorts before the migration under test — the numbered schema
# baseline included — is the pre-migration world.
$before = $all | Where-Object { $_ -lt $Migration }

foreach ($f in $before) {
  & $psql $f
  if ($LASTEXITCODE -ne 0) { Fail "applying $f" }
}
Write-Output "applied $($before.Count) files (schema + migrations up to but not including $Migration)"

# Populate the PRE-migration world, so the migration runs against real data.
& $psql $Seed; if ($LASTEXITCODE -ne 0) { Fail "seeding ($Seed)" }

& $psql $Migration; if ($LASTEXITCODE -ne 0) { Fail "applying $Migration" }
Write-Output "applied $Migration"

# Anything numbered after it, so the whole chain still composes.
foreach ($f in ($all | Where-Object { $_ -gt $Migration })) {
  & $psql $f
  if ($LASTEXITCODE -ne 0) { Fail "applying $f (after $Migration)" }
}

$out = docker exec $name psql -U postgres -d t -X -P pager=off -f "/tmp/$Behavior" 2>&1
$lines = $out -split "`n" | Select-String -Pattern 'PASS |FAIL |ERROR' |
  ForEach-Object { ($_ -replace '^.*NOTICE:\s+', '').Trim() }
$lines | ForEach-Object { Write-Output $_ }

# -cmatch (case-sensitive) so a PASS message mentioning "error" in prose isn't
# read as a failure, and 'ERROR:' so psql's own prefixed errors — which arrive as
# "psql:/tmp/x.sql:12: ERROR: ..." rather than at the start of the line — can't
# slip through as a clean run. A plpgsql compile error kills the WHOLE DO block,
# so missing one of those means reporting zero failures for a file that never ran.
$failed = @($lines | Where-Object { $_ -cmatch '^(FAIL|ERROR)' -or $_ -cmatch 'ERROR:' })
if ($failed.Count -gt 0) { Fail "$($failed.Count) assertion(s)" }

Write-Output ""
Write-Output "ALL $($lines.Count) ASSERTIONS PASSED"
if ($Keep) {
  Write-Output "container '$name' left running: docker exec -it $name psql -U postgres -d t"
} else {
  Drop
}
