// Every function identity written in a migration names a function that migration
// actually declares.
//
// WHY THIS EXISTS. Postgres identifies an overloaded function by its argument
// TYPES, so `comment on function`, `revoke execute on function`, `grant execute
// on function` and `drop function` each have to repeat the parameter list
// exactly. Repeat it wrongly and you get 42883 "function does not exist" —
// pointing at the function you just created, two lines above.
//
// That is a typo with outsized consequences here, for three compounding reasons:
//
//   1. Migrations are applied BY HAND through the Supabase SQL editor. There is
//      no migration runner in package.json, so nothing on a developer machine
//      ever executes one.
//   2. Most of them are wrapped in begin/commit, so one bad identity aborts the
//      transaction and rolls back the WHOLE migration. The failure is not
//      partial; it is total, and it happens after the operator has already
//      pasted hundreds of lines into a web form.
//   3. The real safety net is test/sql/behavior-0NN.sql, which needs Docker or a
//      TEST_SUPABASE_URL. On a machine with neither — which is the normal case
//      here — nothing validates the SQL at all before it is pasted into
//      production.
//
// This test is the cheap half of that net: it needs no database, runs in
// milliseconds, and catches the one mistake that is purely textual. It was
// written after migration-061 shipped a nine-type identity for an eight-argument
// function, copied from migration-060's claim_reminder_pushes, which legitimately
// has one more parameter (its cadence gate). The arities differed by one and
// every other character matched.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../supabase/migrations/', import.meta.url);

/** Drop `--` line comments; parameter lists in this repo are heavily commented. */
const stripComments = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

/** Split on top-level commas, ignoring those inside nested parens. */
function topLevelSplit(s) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; } else buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** The text between the parens that follow `from`, balanced. */
function balanced(sql, open) {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Declared signatures: name -> Set of normalised type lists.
 *
 * A Set because a migration may legitimately declare two overloads of one name
 * (migration-033 and 047 both widened a claim function by adding a parameter),
 * and either is a valid identity to then grant on.
 */
function declared(sql) {
  const map = new Map();
  const re = /create\s+or\s+replace\s+function\s+(public\.\w+)\s*\(/gi;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    const inner = balanced(sql, m.index + m[0].length - 1);
    if (inner === null) continue;
    const types = topLevelSplit(inner).map((p) => {
      // `p_name type [default ...]` -> `type`
      const noDefault = p.split(/\bdefault\b/i)[0].trim();
      const toks = noDefault.split(/\s+/).filter(Boolean);
      return toks.slice(1).join(' ');
    }).filter(Boolean);
    if (!map.has(m[1])) map.set(m[1], new Set());
    map.get(m[1]).add(types.join(', '));
  }
  return map;
}

/**
 * Identities REFERENCED by DDL that needs one — and only the three forms that
 * must match what this migration CREATES.
 *
 * Two exclusions, both deliberate:
 *
 *   • An ordinary call such as `prune_campaigns(30)` carries values, not types.
 *   • `drop function` names a signature that existed BEFORE this file ran, and
 *     the house pattern for widening a function is precisely to drop the old
 *     overload and then create a wider one — migration-033, 047, 002, 019, 028
 *     and 029 all do it, and `drop … (uuid, boolean)` followed by
 *     `create … (uuid, boolean, boolean)` is correct rather than a typo.
 *     Checking drops would flag every one of them.
 *
 * What is left is exactly where the mistake this file was written for lives: a
 * comment, revoke or grant written against the function the same file just
 * declared.
 */
function referenced(sql) {
  const out = [];
  const re = /(?:comment\s+on\s+function|revoke\s+execute\s+on\s+function|grant\s+execute\s+on\s+function)\s+(public\.\w+)\s*\(/gi;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    const inner = balanced(sql, m.index + m[0].length - 1);
    if (inner === null) continue;
    out.push({
      name: m[1],
      sig: topLevelSplit(inner).map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean).join(', '),
      stmt: m[0].trim().split(/\s+/).slice(0, 3).join(' '),
    });
  }
  return out;
}

const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

describe('migration function identities', () => {
  test('there are migrations to check', () => {
    // Guards the whole file: a glob that silently matched nothing would make
    // every assertion below vacuously pass.
    assert.ok(FILES.length > 50, `expected the full migration set, found ${FILES.length}`);
  });

  test('every granted, revoked or commented identity matches the declaration beside it', () => {
    const problems = [];
    for (const file of FILES) {
      const sql = stripComments(readFileSync(new URL(file, DIR), 'utf8'));
      const decls = declared(sql);
      for (const ref of referenced(sql)) {
        const sigs = decls.get(ref.name);
        // A migration may legitimately act on a function an EARLIER one created
        // (a later revoke, a drop of something superseded). Only check names
        // this file declares itself; the cross-file case is what the real
        // database is for.
        if (!sigs) continue;
        if (!sigs.has(ref.sig)) {
          problems.push(
            `${file}\n`
            + `    ${ref.stmt} ${ref.name}(${ref.sig})\n`
            + `      declares: ${[...sigs].map((s) => `(${s})`).join('  |  ')}\n`
            + `      arity referenced ${ref.sig ? ref.sig.split(',').length : 0}, `
            + `declared ${[...sigs].map((s) => (s ? s.split(',').length : 0)).join('/')}`,
          );
        }
      }
    }
    assert.deepEqual(
      problems, [],
      `a function identity does not match its own declaration, which raises 42883 and `
      + `(inside begin/commit) rolls the whole migration back:\n\n${problems.join('\n\n')}\n`,
    );
  });

  test('a SECURITY DEFINER function always pins search_path', () => {
    // Not an identity problem, but the same class: invisible until something
    // resolves an unqualified name against the caller's path. Checked here
    // because this is the only test that already parses every migration.
    const problems = [];
    for (const file of FILES) {
      const sql = stripComments(readFileSync(new URL(file, DIR), 'utf8'));
      const re = /create\s+or\s+replace\s+function\s+(public\.\w+)\s*\(/gi;
      for (let m = re.exec(sql); m; m = re.exec(sql)) {
        const inner = balanced(sql, m.index + m[0].length - 1);
        if (inner === null) continue;
        // The body between the header and its dollar-quoted block.
        const end = m.index + m[0].length;
        const after = sql.slice(end + inner.length, sql.indexOf('$$', end));
        if (/security\s+definer/i.test(after) && !/set\s+search_path/i.test(after)) {
          problems.push(`${file}: ${m[1]} is SECURITY DEFINER with no search_path`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });
});
