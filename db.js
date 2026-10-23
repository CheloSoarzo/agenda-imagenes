// Base de datos SQLite: usuarios, sesiones y citas.
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "agenda.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre TEXT NOT NULL DEFAULT '',
  clave_hash TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'recepcion' CHECK (rol IN ('admin','recepcion','lectura')),
  activo INTEGER NOT NULL DEFAULT 1,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS citas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  hora TEXT NOT NULL,
  duracion INTEGER NOT NULL DEFAULT 15,
  equipo TEXT NOT NULL CHECK (equipo IN ('tc','rx','eco')),
  paciente TEXT NOT NULL,
  rut TEXT NOT NULL DEFAULT '',
  telefono TEXT NOT NULL DEFAULT '',
  examen TEXT NOT NULL DEFAULT '',
  prevision TEXT NOT NULL DEFAULT '',
  medico TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'agendado',
  notas TEXT NOT NULL DEFAULT '',
  creado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  actualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_citas_fecha ON citas(fecha);
CREATE INDEX IF NOT EXISTS idx_citas_rut ON citas(rut);
`);

// ---------- módulo de pagos ----------
db.exec(`
CREATE TABLE IF NOT EXISTS aranceles (
  codigo TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  equipo TEXT NOT NULL CHECK (equipo IN ('tc','rx','eco')),
  fonasa_total INTEGER NOT NULL DEFAULT 0,   -- valor prestación Fonasa MLE nivel 2
  fonasa_bonif INTEGER NOT NULL DEFAULT 0,   -- bonificación Fonasa nivel 2
  particular INTEGER NOT NULL DEFAULT 0,     -- precio particular del centro (0 = usar valor Fonasa)
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pagos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cita_id INTEGER REFERENCES citas(id) ON DELETE SET NULL,
  fecha TEXT NOT NULL,                 -- día de caja
  paciente TEXT NOT NULL DEFAULT '',
  rut TEXT NOT NULL DEFAULT '',
  equipo TEXT NOT NULL DEFAULT '',
  codigo TEXT NOT NULL DEFAULT '',
  examen TEXT NOT NULL DEFAULT '',
  prevision TEXT NOT NULL DEFAULT '',
  valor INTEGER NOT NULL DEFAULT 0,
  bonificacion INTEGER NOT NULL DEFAULT 0,
  copago INTEGER NOT NULL DEFAULT 0,   -- lo que pagó el paciente
  medio TEXT NOT NULL,
  folio_bono TEXT NOT NULL DEFAULT '',
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  anulado INTEGER NOT NULL DEFAULT 0,
  anulado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_anulacion TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pagos_fecha ON pagos(fecha);
CREATE INDEX IF NOT EXISTS idx_pagos_cita ON pagos(cita_id);

CREATE TABLE IF NOT EXISTS cierres (
  fecha TEXT PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  resumen TEXT NOT NULL,               -- totales en JSON al momento del cierre
  efectivo_contado INTEGER NOT NULL DEFAULT 0,
  diferencia INTEGER NOT NULL DEFAULT 0,
  observaciones TEXT NOT NULL DEFAULT ''
);
`);

// Columnas nuevas en citas (para bases creadas con la versión anterior)
const colsCitas = db.prepare("PRAGMA table_info(citas)").all().map((c) => c.name);
for (const [col, def] of [["codigo", "TEXT NOT NULL DEFAULT ''"], ["valor", "INTEGER NOT NULL DEFAULT 0"],
  ["bonificacion", "INTEGER NOT NULL DEFAULT 0"], ["copago", "INTEGER NOT NULL DEFAULT 0"]]) {
  if (!colsCitas.includes(col)) db.exec(`ALTER TABLE citas ADD COLUMN ${col} ${def}`);
}

// Arancel Fonasa incluido con la app. Se aplica cuando el archivo trae una versión más nueva que la
// cargada: inserta códigos nuevos y actualiza valor y bonificación Fonasa, sin tocar el precio
// particular ni si la prestación está activa. Las citas Fonasa aún no pagadas se recalculan.
db.exec("CREATE TABLE IF NOT EXISTS meta (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)");
try {
  const ini = JSON.parse(fs.readFileSync(path.join(__dirname, "data-inicial", "aranceles-fonasa-2026-nivel2.json"), "utf8"));
  const cargada = Number(db.prepare("SELECT valor FROM meta WHERE clave = 'arancel_version'").get()?.valor || 0);
  if ((ini.version || 1) > cargada) {
    const up = db.prepare(`INSERT INTO aranceles (codigo, nombre, equipo, fonasa_total, fonasa_bonif) VALUES (?,?,?,?,?)
      ON CONFLICT(codigo) DO UPDATE SET nombre = excluded.nombre, equipo = excluded.equipo,
      fonasa_total = excluded.fonasa_total, fonasa_bonif = excluded.fonasa_bonif`);
    db.exec("BEGIN");
    for (const a of ini.prestaciones) up.run(a.codigo, a.nombre, a.equipo, a.fonasa_total, a.fonasa_bonif);
    const r = db.prepare(`UPDATE citas SET
        valor = (SELECT fonasa_total FROM aranceles a WHERE a.codigo = citas.codigo),
        bonificacion = (SELECT fonasa_bonif FROM aranceles a WHERE a.codigo = citas.codigo),
        copago = (SELECT fonasa_total - fonasa_bonif FROM aranceles a WHERE a.codigo = citas.codigo)
      WHERE prevision = 'Fonasa' AND codigo IN (SELECT codigo FROM aranceles)
        AND NOT EXISTS (SELECT 1 FROM pagos p WHERE p.cita_id = citas.id AND p.anulado = 0)`).run();
    db.prepare("INSERT INTO meta (clave, valor) VALUES ('arancel_version', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor")
      .run(String(ini.version || 1));
    db.exec("COMMIT");
    console.log(`Arancel Fonasa actualizado: ${ini.prestaciones.length} prestaciones (versión ${ini.version}). Citas Fonasa sin pagar recalculadas: ${r.changes}.`);
  }
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  console.error("No se pudo cargar el arancel Fonasa:", e.message);
}

// Claves: scrypt con sal aleatoria (incluido en Node, sin dependencias)
const crypto = require("crypto");
db.hashClave = (clave) => {
  const sal = crypto.randomBytes(16).toString("hex");
  return "scrypt$" + sal + "$" + crypto.scryptSync(String(clave), sal, 64).toString("hex");
};
db.verificarClave = (clave, guardada) => {
  const [tipo, sal, hash] = String(guardada).split("$");
  if (tipo !== "scrypt" || !sal || !hash) return false;
  const a = Buffer.from(hash, "hex"), b = crypto.scryptSync(String(clave), sal, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = db;
