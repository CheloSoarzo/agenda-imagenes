// Cargar un respaldo: reemplaza los datos de esta agenda por los de un archivo de respaldo (.db).
//
// Sirve, por ejemplo, cuando se agendaron pacientes en la agenda equivocada: se descarga el respaldo de esa
// agenda y se carga aquí. Antes de reemplazar, se guarda automáticamente una copia de la agenda actual en
// DATA_DIR/respaldos/ (para poder volver atrás). Después, el PACS se pone al día con las citas restauradas.
//
// Se hace en dos pasos: 1) se sube el archivo y se revisa (cuántas citas tiene cada uno);
// 2) se confirma escribiendo RESTAURAR.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const MAX = 500 * 1024 * 1024;   // 500 MB
// Tablas que no se copian: sesiones (todos vuelven a entrar), meta (ajustes propios de este servidor), cola del PACS
const NO_COPIAR = new Set(["sesiones", "meta", "pacs_cola", "sqlite_sequence"]);

module.exports = function respaldo(db, { ahoraCaja, fallo, integ }) {
  const dirTmp = path.join(db.dataDir, "respaldos", "tmp");
  const dirCopias = path.join(db.dataDir, "respaldos");
  fs.mkdirSync(dirTmp, { recursive: true });

  function leerArchivo(req) {
    return new Promise((ok, mal) => {
      const partes = []; let total = 0;
      req.on("data", (c) => { total += c.length; if (total > MAX) { mal(Object.assign(new Error("El archivo es demasiado grande."), { status: 413 })); req.destroy(); } else partes.push(c); });
      req.on("end", () => ok(Buffer.concat(partes)));
      req.on("error", mal);
    });
  }

  function resumen(con) {
    const n = (sql) => { try { return con.prepare(sql).get().n; } catch { return 0; } };
    const r = (sql) => { try { return con.prepare(sql).get(); } catch { return {}; } };
    const f = r("SELECT MIN(fecha) AS desde, MAX(fecha) AS hasta FROM citas");
    return { citas: n("SELECT COUNT(*) AS n FROM citas"), pagos: n("SELECT COUNT(*) AS n FROM pagos WHERE anulado = 0"),
      usuarios: n("SELECT COUNT(*) AS n FROM usuarios"), desde: f.desde || "", hasta: f.hasta || "" };
  }

  function limpiarViejos() {
    for (const n of fs.readdirSync(dirTmp)) {
      const p = path.join(dirTmp, n);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { force: true }); } catch {}
    }
  }

  const rutas = [
    // Paso 1: subir y revisar el archivo
    ["POST", /^\/api\/respaldo\/revisar$/, "admin", async (req) => {
      limpiarViejos();
      const datos = await leerArchivo(req);
      if (datos.subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") fallo(400, "El archivo no es un respaldo de la agenda (.db).");
      const token = crypto.randomBytes(16).toString("hex");
      const ruta = path.join(dirTmp, token + ".db");
      fs.writeFileSync(ruta, datos);
      let con;
      try {
        con = new DatabaseSync(ruta, { readOnly: true });
        const tablas = new Set(con.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
        if (!tablas.has("citas") || !tablas.has("usuarios")) throw new Error("no es una agenda");
        const ok = con.prepare("PRAGMA integrity_check").get();
        if (Object.values(ok)[0] !== "ok") throw new Error("archivo dañado");
        const nuevo = resumen(con);
        con.close();
        return [200, { token, actual: resumen(db), respaldo: nuevo }];
      } catch (e) {
        try { con && con.close(); } catch {}
        fs.rmSync(ruta, { force: true });
        fallo(400, "El archivo no es un respaldo válido de la agenda (" + e.message + ").");
      }
    }],

    // Paso 2: confirmar y reemplazar
    ["POST", /^\/api\/respaldo\/restaurar$/, "admin", async (req, u, url) => {
      const token = String(url.searchParams.get("token") || "");
      const confirmar = String(url.searchParams.get("confirmar") || "").trim().toUpperCase();
      if (!/^[0-9a-f]{32}$/.test(token)) fallo(400, "Vuelve a subir el archivo.");
      if (confirmar !== "RESTAURAR") fallo(400, "Escribe RESTAURAR para confirmar.");
      const ruta = path.join(dirTmp, token + ".db");
      if (!fs.existsSync(ruta)) fallo(400, "El archivo ya no está disponible: vuelve a subirlo.");

      // copia de seguridad de lo que hay ahora (para poder volver atrás)
      const sello = ahoraCaja().replace(/[: ]/g, "-").slice(0, 16);
      let copia = path.join(dirCopias, `antes-de-restaurar-${sello}.db`);
      for (let k = 2; fs.existsSync(copia); k++) copia = path.join(dirCopias, `antes-de-restaurar-${sello}-${k}.db`);
      db.exec(`VACUUM INTO '${copia.replace(/'/g, "''")}'`);
      const anteriores = db.prepare("SELECT id, accesion, fecha, hora, equipo, rut FROM citas WHERE accesion != ''").all();
      const seqAntes = Math.max(0, ...anteriores.map((o) => o.id),
        Number((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'citas'").get() || {}).seq || 0));

      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(`ATTACH DATABASE '${ruta.replace(/'/g, "''")}' AS r`);
      try {
        db.exec("BEGIN");
        const propias = db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all().map((t) => t.name);
        const delRespaldo = new Set(db.prepare("SELECT name FROM r.sqlite_master WHERE type = 'table'").all().map((t) => t.name));
        const copiadas = [];
        for (const t of propias) {
          if (NO_COPIAR.has(t) || t.startsWith("sqlite_")) continue;
          db.exec(`DELETE FROM main."${t}"`);
          if (!delRespaldo.has(t)) continue;
          const colsMain = db.prepare(`PRAGMA main.table_info("${t}")`).all().map((c) => c.name);
          const colsR = new Set(db.prepare(`PRAGMA r.table_info("${t}")`).all().map((c) => c.name));
          const cols = colsMain.filter((c) => colsR.has(c)).map((c) => `"${c}"`).join(",");
          if (cols) { db.exec(`INSERT INTO main."${t}" (${cols}) SELECT ${cols} FROM r."${t}"`); copiadas.push(t); }
        }
        if (delRespaldo.has("sqlite_sequence")) {
          db.exec("DELETE FROM main.sqlite_sequence");
          db.exec("INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM r.sqlite_sequence");
        }
        // Las citas nuevas nunca reutilizan un número ya usado en esta agenda (ni su número de acceso en el PACS)
        db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'citas'").run(seqAntes);
        if (!db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = 'citas'").get())
          db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('citas', ?)").run(seqAntes);
        // Si una cita del respaldo trae un número de acceso que aquí era de otra cita (otro paciente u otra fecha),
        // recibe uno nuevo: así nunca se une con imágenes de otro paciente en el PACS.
        const norm = (r) => String(r || "").replace(/[^0-9kK]/g, "").toUpperCase();
        const antes = new Map(anteriores.map((o) => [o.accesion, o]));
        const usados = new Set(anteriores.map((o) => o.accesion));
        const upAcc = db.prepare("UPDATE citas SET accesion = ? WHERE id = ?");
        for (const c of db.prepare("SELECT id, accesion, fecha, rut FROM citas WHERE accesion != ''").all()) {
          const o = antes.get(c.accesion);
          if (!o || (o.id === c.id && o.fecha === c.fecha && norm(o.rut) === norm(c.rut))) continue;
          let k = 1, acc;
          do { acc = (c.accesion.slice(0, 13) + "R" + k++); } while (usados.has(acc) || db.prepare("SELECT 1 FROM citas WHERE accesion = ?").get(acc));
          usados.add(acc);
          upAcc.run(acc, c.id);
        }
        db.exec("DELETE FROM sesiones");        // todos vuelven a iniciar sesión (los usuarios pueden haber cambiado)
        db.exec("COMMIT");
        db.exec("DETACH DATABASE r");
        db.exec("PRAGMA foreign_keys = ON");
        // datos de versiones anteriores: exámenes en MAYÚSCULAS y citas sin número de acceso
        const M = (v) => String(v ?? "").toLocaleUpperCase("es-CL");
        const up = db.prepare("UPDATE citas SET examen = ?, examenes = ? WHERE id = ?");
        for (const c of db.prepare("SELECT id, examen, examenes FROM citas").all()) {
          let exs = c.examenes || "";
          try { if (exs) exs = JSON.stringify(JSON.parse(exs).map((l) => ({ ...l, nombre: M(l.nombre) }))); } catch {}
          if (c.examen !== M(c.examen) || exs !== (c.examenes || "")) up.run(M(c.examen), exs, c.id);
        }
        const sinAcc = db.prepare("SELECT id FROM citas WHERE accesion = ''").all();
        for (const r of sinAcc) db.prepare("UPDATE citas SET accesion = ? WHERE id = ?").run(db.accesionDe(r.id), r.id);
        fs.rmSync(ruta, { force: true });
        integ.resincronizar(anteriores);
        console.log(`Respaldo restaurado por ${u.usuario}: tablas ${copiadas.join(", ")}. Copia previa: ${copia}`);
        return [200, { ok: true, copia: path.basename(copia), ...resumen(db) }];
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch {}
        try { db.exec("DETACH DATABASE r"); } catch {}
        db.exec("PRAGMA foreign_keys = ON");
        fallo(500, "No se pudo restaurar el respaldo: " + e.message + ". La agenda quedó como estaba.");
      }
    }],
  ];
  return { rutas };
};
