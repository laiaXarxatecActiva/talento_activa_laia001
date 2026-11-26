#!/usr/bin/env node
// =============================================================================
// check-locked-tests.mjs
//
// Hace cumplir la regla del proyecto: un test de una funcionalidad YA ACABADA
// no se modifica ni se borra en tareas de desarrollo posteriores.
//
// Cómo funciona:
//   - Cuando una funcionalidad se da por acabada, se "bloquean" sus tests:
//     se guarda el SHA-256 de cada fichero en tests.lock.json.
//   - `check` verifica que ningún test bloqueado ha cambiado o desaparecido.
//   - Modificar un test bloqueado exige desbloquearlo primero (`unlock`), lo
//     que solo debe hacerse con el OK explícito del responsable.
//
// Uso:
//   node scripts/check-locked-tests.mjs check              # verifica (por defecto)
//   node scripts/check-locked-tests.mjs lock [rutas...]    # bloquea tests (todos si no se indican)
//   node scripts/check-locked-tests.mjs lock --force <ruta># re-bloquea uno modificado (requiere OK)
//   node scripts/check-locked-tests.mjs unlock <rutas...>  # desbloquea (requiere OK)
//   node scripts/check-locked-tests.mjs status             # resumen
//
// Códigos de salida: 0 = OK, 1 = violación/uso incorrecto.
// Sin dependencias externas: solo Node (node >= 18).
// =============================================================================

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const LOCKFILE = join(ROOT, 'tests.lock.json');

// Patrón de ficheros de test y directorios a ignorar al autodescubrir.
const TEST_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);

// --- utilidades -------------------------------------------------------------

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function toRel(path) {
  // Clave de lockfile siempre relativa al root y con separador "/".
  return relative(ROOT, path).split(sep).join('/');
}

function isTestFile(relPath) {
  return TEST_RE.test(relPath);
}

function walkTests(dir = ROOT, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (IGNORE_DIRS.has(entry.name)) continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walkTests(full, acc);
    } else if (entry.isFile() && isTestFile(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function loadLock() {
  if (!existsSync(LOCKFILE)) return { version: 1, locked: {} };
  try {
    const data = JSON.parse(readFileSync(LOCKFILE, 'utf8'));
    if (!data.locked) data.locked = {};
    return data;
  } catch {
    console.error(`✗ tests.lock.json no es un JSON válido.`);
    process.exit(1);
  }
}

function saveLock(lock) {
  writeFileSync(LOCKFILE, JSON.stringify(lock, null, 2) + '\n');
}

function nowISO() {
  return new Date().toISOString();
}

// --- comandos ---------------------------------------------------------------

function cmdCheck() {
  const lock = loadLock();
  const entries = Object.entries(lock.locked);
  const violations = [];

  for (const [rel, meta] of entries) {
    const full = join(ROOT, rel);
    if (!existsSync(full)) {
      violations.push({ rel, kind: 'borrado' });
      continue;
    }
    if (sha256(full) !== meta.sha256) {
      violations.push({ rel, kind: 'modificado' });
    }
  }

  if (violations.length === 0) {
    console.log(`✓ Tests bloqueados intactos (${entries.length}).`);
    process.exit(0);
  }

  console.error(`✗ Se han alterado tests de funcionalidades ya acabadas:\n`);
  for (const v of violations) {
    console.error(`  - [${v.kind}] ${v.rel}`);
  }
  console.error(
    `\nLos tests bloqueados no deben cambiarse. Si es imprescindible y tienes` +
    ` el OK:\n` +
    `  node scripts/check-locked-tests.mjs unlock <ruta>   # desbloquear\n` +
    `  (edita el test)\n` +
    `  node scripts/check-locked-tests.mjs lock <ruta>     # volver a bloquear\n`
  );
  process.exit(1);
}

function cmdLock(args) {
  const force = args.includes('--force');
  const paths = args.filter((a) => a !== '--force');

  const lock = loadLock();
  let targets;
  if (paths.length > 0) {
    targets = paths.map((p) => join(ROOT, p));
    for (const t of targets) {
      if (!existsSync(t)) {
        console.error(`✗ No existe: ${toRel(t)}`);
        process.exit(1);
      }
      if (!isTestFile(toRel(t))) {
        console.error(`✗ No parece un fichero de test: ${toRel(t)}`);
        process.exit(1);
      }
    }
  } else {
    targets = walkTests();
  }

  const added = [];
  const reForced = [];
  const blocked = [];

  for (const full of targets) {
    const rel = toRel(full);
    const hash = sha256(full);
    const prev = lock.locked[rel];
    if (!prev) {
      lock.locked[rel] = { sha256: hash, lockedAt: nowISO() };
      added.push(rel);
    } else if (prev.sha256 === hash) {
      // ya bloqueado e intacto: nada que hacer
    } else if (force) {
      lock.locked[rel] = { sha256: hash, lockedAt: nowISO(), reForcedAt: nowISO() };
      reForced.push(rel);
    } else {
      blocked.push(rel);
    }
  }

  if (blocked.length > 0) {
    console.error(
      `✗ Estos tests ya están bloqueados y han cambiado. Re-bloquear requiere` +
      ` --force (y el OK del responsable):\n`
    );
    for (const r of blocked) console.error(`  - ${r}`);
    process.exit(1);
  }

  saveLock(lock);
  console.log(`✓ Bloqueo actualizado. Nuevos: ${added.length}, re-forzados: ${reForced.length}.`);
  for (const r of added) console.log(`  + ${r}`);
  for (const r of reForced) console.log(`  ! ${r} (re-bloqueado con --force)`);
}

function cmdUnlock(args) {
  if (args.length === 0) {
    console.error(`✗ Indica al menos una ruta a desbloquear.`);
    process.exit(1);
  }
  const lock = loadLock();
  const removed = [];
  for (const p of args) {
    const rel = toRel(join(ROOT, p));
    if (lock.locked[rel]) {
      delete lock.locked[rel];
      removed.push(rel);
    } else {
      console.error(`  (aviso) no estaba bloqueado: ${rel}`);
    }
  }
  saveLock(lock);
  console.log(`✓ Desbloqueados: ${removed.length}. Edítalos y vuelve a bloquearlos al terminar.`);
  for (const r of removed) console.log(`  - ${r}`);
}

function cmdStatus() {
  const lock = loadLock();
  const entries = Object.entries(lock.locked);
  const onDisk = walkTests().map(toRel);
  const lockedSet = new Set(entries.map(([r]) => r));
  const unlocked = onDisk.filter((r) => !lockedSet.has(r));

  console.log(`Tests bloqueados: ${entries.length}`);
  console.log(`Tests sin bloquear (en desarrollo): ${unlocked.length}`);
  for (const r of unlocked) console.log(`  · ${r}`);
}

// --- entrada ----------------------------------------------------------------

const [, , cmd = 'check', ...rest] = process.argv;
switch (cmd) {
  case 'check': cmdCheck(); break;
  case 'lock': cmdLock(rest); break;
  case 'unlock': cmdUnlock(rest); break;
  case 'status': cmdStatus(); break;
  default:
    console.error(`Comando desconocido: ${cmd}\nUsa: check | lock | unlock | status`);
    process.exit(1);
}
