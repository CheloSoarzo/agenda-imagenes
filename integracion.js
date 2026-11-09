// Integración con el PACS y portal de exámenes del paciente.
//
// La agenda envía cada cita al PACS como una "orden" (con su número de acceso). Con eso el PACS:
//   - arma la lista de trabajo (worklist DICOM) que leen los equipos,
//   - une las imágenes y el informe con la cita,
//   - deja que el paciente vea su examen en línea con su RUT y su clave.
// El PACS devuelve el avance de cada examen (imágenes recibidas, informado, entregado).
//
// Variables:
//   PACS_URL            dirección de la app de informes del PACS (ej: https://pacsrancagua.inq.cl
//                       o, en el mismo servidor, http://rancagua-informes:8000). Vacía = sin integración.
//   INTEGRACION_TOKEN   clave compartida con el PACS (la misma en ambos lados)
//   PORTAL_URL          dirección que se imprime en la hoja de retiro (por defecto PACS_URL/paciente)
//   ACCESION_PREFIJO    letras al inicio del número de acceso (por defecto AG)
//   PACS_PUBLICO_URL    dirección del PACS que abre el navegador (botón «Ver en el PACS»). Por defecto PACS_URL
//                       si es https.
const crypto = require("crypto");

const PACS_URL = String(process.env.PACS_URL || "").trim().replace(/\/+$/, "");
const TOKEN = String(process.env.INTEGRACION_TOKEN || "").trim();
const PORTAL_URL = String(process.env.PORTAL_URL || "").trim().replace(/\/+$/, "") || (PACS_URL && !/^http:\/\//.test(PACS_URL) ? PACS_URL + "/paciente" : "");
const ACTIVA = !!(PACS_URL && TOKEN);
const PACS_PUBLICO = String(process.env.PACS_PUBLICO_URL || "").trim().replace(/\/+$/, "") || (/^https:\/\//.test(PACS_URL) ? PACS_URL : "");
const ESTADOS_PACS = ["imagenes", "informado", "entregado"];
const INTERVALO = Math.max(5, Number(process.env.PACS_INTERVALO_SEG) || 60);   // cada cuánto se consulta el avance

// Letras y números fáciles de dictar (sin 0/O, 1/I/L)
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function claveNueva() {
  let s = "";
  for (const b of crypto.randomBytes(8)) s += ALFABETO[b % ALFABETO.length];
  return s;
}
const normRut = (rut) => String(rut || "").replace(/[^0-9kK]/g, "").toUpperCase();
const rutValido = (rut) => {
  const r = normRut(rut);
  if (r.length < 7 || r.length > 9) return false;
  const cuerpo = r.slice(0, -1), dv = r.slice(-1);
  if (!/^\d+$/.test(cuerpo)) return false;
  let suma = 0, mul = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) { suma += Number(cuerpo[i]) * mul; mul = mul === 7 ? 2 : mul + 1; }
  const res = 11 - (suma % 11);
  return dv === (res === 11 ? "0" : res === 10 ? "K" : String(res));
};

module.exports = function integracion(db, { ahoraCaja, hoyCaja, fallo, plain }) {
  // ---------- órdenes hacia el PACS ----------
  function datosOrden(cita) {
    let examenes = [];
    try { examenes = cita.examenes ? JSON.parse(cita.examenes) : []; } catch {}
    if (!examenes.length && (cita.codigo || cita.examen)) examenes = [{ codigo: cita.codigo, nombre: cita.examen }];
    const pagado = !!db.prepare("SELECT 1 FROM pagos WHERE cita_id = ? AND anulado = 0").get(cita.id);
    const rut = normRut(cita.rut);
    const clave = rut ? db.prepare("SELECT clave_hash FROM portal_claves WHERE rut = ?").get(rut) : null;
    return {
      accesion: cita.accesion || db.accesionDe(cita.id), cita_id: cita.id,
      fecha: cita.fecha, hora: cita.hora, duracion: cita.duracion, equipo: cita.equipo,
      paciente: cita.paciente, rut: cita.rut, rut_norm: rut, fecha_nac: cita.fecha_nac || "",
      email: cita.email || "", telefono: cita.telefono || "", medico: cita.medico || "", medico_id: Number(cita.medico_id) || 0, prevision: cita.prevision || "",
      examen: cita.examen || "", examenes: examenes.map((l) => ({ codigo: l.codigo || "", nombre: l.nombre || "" })),
      notas: cita.notas || "", estado: cita.estado, pagado, eliminada: false,
      clave_hash: clave ? clave.clave_hash : "",
    };
  }
  const encolar = db.prepare(`INSERT INTO pacs_cola (cita_id, datos, intentos, error, version) VALUES (?, ?, 0, '', 1)
    ON CONFLICT(cita_id) DO UPDATE SET datos = excluded.datos, intentos = 0, error = '', version = pacs_cola.version + 1`);

  function avisar(citaId) {
    if (!ACTIVA) return;
    const c = db.prepare("SELECT * FROM citas WHERE id = ?").get(citaId);
    if (c) encolar.run(citaId, JSON.stringify(datosOrden(c)));
    enviarPronto();
  }
  // Antes de borrar una cita: avisa al PACS que la orden ya no existe
  function avisarEliminada(citaId) {
    if (!ACTIVA) return;
    const c = db.prepare("SELECT * FROM citas WHERE id = ?").get(citaId);
    if (!c) return;
    encolar.run(citaId, JSON.stringify({ ...datosOrden(c), eliminada: true }));
    enviarPronto();
  }
  // Todas las citas de un paciente (cuando cambia su clave)
  function avisarPaciente(rut) {
    if (!ACTIVA || !rut) return;
    const ids = db.prepare(`SELECT id FROM citas WHERE UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')) = ?`).all(rut);
    for (const { id } of ids) { const c = db.prepare("SELECT * FROM citas WHERE id = ?").get(id); encolar.run(id, JSON.stringify(datosOrden(c))); }
    enviarPronto();
  }

  async function llamar(metodo, ruta, cuerpo) {
    const r = await fetch(PACS_URL + ruta, {
      method: metodo, signal: AbortSignal.timeout(20000),
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch {}
    if (!r.ok) throw new Error((data && data.error) || `El PACS respondió ${r.status}`);
    return data;
  }

  let enviando = false, pronto = null;
  function enviarPronto() { clearTimeout(pronto); pronto = setTimeout(enviarCola, 300); }
  async function enviarCola() {
    if (!ACTIVA || enviando) return;
    enviando = true;
    try {
      for (;;) {
        const filas = db.prepare("SELECT cita_id, datos, version FROM pacs_cola WHERE intentos < 1000 ORDER BY intentos, cita_id LIMIT 50").all();
        if (!filas.length) break;
        try {
          await llamar("POST", "/api/integracion/ordenes", { ordenes: filas.map((f) => JSON.parse(f.datos)) });
        } catch (e) {
          const up = db.prepare("UPDATE pacs_cola SET intentos = intentos + 1, error = ? WHERE cita_id = ?");
          for (const f of filas) up.run(String(e.message).slice(0, 300), f.cita_id);
          ultimoError = String(e.message); break;
        }
        const del = db.prepare("DELETE FROM pacs_cola WHERE cita_id = ? AND version = ?");
        for (const f of filas) del.run(f.cita_id, f.version);
        ultimoOk = ahoraCaja(); ultimoError = "";
      }
    } finally { enviando = false; }
  }

  // ---------- avance de los exámenes desde el PACS ----------
  let ultimoOk = "", ultimoError = "";
  let pacsDelPacs = (db.prepare("SELECT valor FROM meta WHERE clave = 'pacs_url'").get() || {}).valor || "";
  async function traerEstados() {
    if (!ACTIVA) return;
    const desde = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
    let data;
    try { data = await llamar("GET", "/api/integracion/estados?desde=" + desde); }
    catch (e) { ultimoError = String(e.message); return; }
    ultimoOk = ahoraCaja();
    // El PACS informa su dirección pública (para el botón «Ver en el PACS»)
    const pu = String((data && data.pacs_url) || "").trim().replace(/\/+$/, "");
    if (/^https?:\/\/[^\s]+$/.test(pu) && pu !== pacsDelPacs) {
      pacsDelPacs = pu;
      db.prepare("INSERT INTO meta (clave, valor) VALUES ('pacs_url', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(pu);
    }
    const porAcc = db.prepare("SELECT id, estado, pacs_estado, pacs_detalle FROM citas WHERE accesion = ?");
    const up = db.prepare("UPDATE citas SET pacs_estado = ?, pacs_detalle = ? WHERE id = ?");
    const atendido = db.prepare("UPDATE citas SET estado = 'atendido' WHERE id = ? AND estado IN ('llego','confirmado','agendado')");
    for (const e of (data && data.estados) || []) {
      const c = porAcc.get(String(e.accesion || ""));
      if (!c) continue;
      // El estudio se borró del PACS: la cita vuelve a quedar sin imágenes (hasta que llegue uno nuevo)
      if (e.estado === "sin_imagenes") { if (c.pacs_estado !== "" || c.pacs_detalle !== "") up.run("", "", c.id); continue; }
      if (!ESTADOS_PACS.includes(e.estado)) continue;
      const det = JSON.stringify(e.detalle || {});
      if (c.pacs_estado !== e.estado || c.pacs_detalle !== det) up.run(e.estado, det, c.id);
      if (c.pacs_estado === "" && e.estado) atendido.run(c.id);   // llegaron las imágenes: el examen se hizo
    }
  }

  if (ACTIVA) {
    setInterval(enviarCola, 30000).unref();
    setInterval(traerEstados, INTERVALO * 1000).unref();
    setTimeout(() => { enviarCola(); traerEstados(); }, 3000).unref();
    // Al iniciar por primera vez con la integración: envía las citas desde hoy en adelante
    const hecho = db.prepare("SELECT valor FROM meta WHERE clave = 'pacs_inicial'").get();
    if (!hecho) {
      const ids = db.prepare("SELECT id FROM citas WHERE fecha >= date('now','-30 day')").all();
      for (const { id } of ids) { const c = db.prepare("SELECT * FROM citas WHERE id = ?").get(id); encolar.run(id, JSON.stringify(datosOrden(c))); }
      db.prepare("INSERT INTO meta (clave, valor) VALUES ('pacs_inicial', ?)").run(ahoraCaja());
    }
  }

  // Después de restaurar un respaldo: el PACS borra las órdenes que ya no existen y recibe todas las citas
  function resincronizar(anteriores) {
    if (!ACTIVA) return;
    db.exec("DELETE FROM pacs_cola");
    const existe = db.prepare("SELECT 1 FROM citas WHERE accesion = ?");
    for (const o of anteriores || []) {
      if (!o.accesion || existe.get(o.accesion)) continue;
      encolar.run(-Math.abs(o.id), JSON.stringify({ accesion: o.accesion, cita_id: o.id, fecha: o.fecha, hora: o.hora || "",
        equipo: o.equipo || "tc", paciente: "", rut: "", rut_norm: "", examenes: [], eliminada: true, pagado: false }));
    }
    const ids = db.prepare("SELECT id FROM citas WHERE fecha >= date('now','-60 day')").all();
    for (const { id } of ids) { const c = db.prepare("SELECT * FROM citas WHERE id = ?").get(id); encolar.run(id, JSON.stringify(datosOrden(c))); }
    enviarPronto();
  }

  // ---------- cifrado de la clave del paciente (para que el administrador pueda verla) ----------
  // AES-256-GCM con una llave guardada en DATA_DIR/clave-portal.key (fuera de la base de datos y de los respaldos):
  // quien copie solo la base de datos no puede leer las claves.
  const ARCHIVO_LLAVE = require("path").join(db.dataDir, "clave-portal.key");
  let llave = null;
  function llavePortal() {
    if (llave) return llave;
    const fs = require("fs");
    try { llave = Buffer.from(fs.readFileSync(ARCHIVO_LLAVE, "utf8").trim(), "hex"); } catch {}
    if (!llave || llave.length !== 32) {
      llave = crypto.randomBytes(32);
      fs.writeFileSync(ARCHIVO_LLAVE, llave.toString("hex") + "\n", { mode: 0o600 });
    }
    return llave;
  }
  function cifrar(texto) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", llavePortal(), iv);
    const datos = Buffer.concat([c.update(texto, "utf8"), c.final()]);
    return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), datos.toString("base64")].join(":");
  }
  function descifrar(guardado) {
    const [v, iv, tag, datos] = String(guardado || "").split(":");
    if (v !== "v1") return null;
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", llavePortal(), Buffer.from(iv, "base64"));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(datos, "base64")), d.final()]).toString("utf8");
    } catch { return null; }   // llave distinta (ej. base restaurada en otro servidor)
  }

  // ---------- clave del paciente ----------
  // Si el paciente aún no tiene clave, la crea. Devuelve la clave nueva (solo esa vez) o null si ya tenía.
  function asegurarClave(rut, usuarioId) {
    const r = normRut(rut);
    if (!r || !rutValido(r)) return { estado: "sin_rut" };
    if (db.prepare("SELECT 1 FROM portal_claves WHERE rut = ?").get(r)) return { estado: "existente" };
    const clave = claveNueva();
    db.prepare("INSERT INTO portal_claves (rut, clave_hash, clave_cifrada, usuario_id, creado) VALUES (?,?,?,?,?)")
      .run(r, db.hashClave(clave), cifrar(clave), usuarioId, ahoraCaja());
    return { estado: "nueva", clave };
  }
  function cambiarClave(rut, usuarioId) {
    const r = normRut(rut);
    if (!r || !rutValido(r)) fallo(400, "La cita necesita un RUT válido para crear la clave del paciente.");
    const clave = claveNueva();
    db.prepare(`INSERT INTO portal_claves (rut, clave_hash, clave_cifrada, usuario_id, creado) VALUES (?,?,?,?,?)
      ON CONFLICT(rut) DO UPDATE SET clave_hash = excluded.clave_hash, clave_cifrada = excluded.clave_cifrada,
        usuario_id = excluded.usuario_id, creado = excluded.creado`)
      .run(r, db.hashClave(clave), cifrar(clave), usuarioId, ahoraCaja());
    avisarPaciente(r);
    return clave;
  }

  // ---------- médicos solicitantes del PACS (para la lista de la cita) ----------
  let medicosCache = { t: 0, lista: [] };
  async function medicos() {
    if (!ACTIVA) return [];
    if (Date.now() - medicosCache.t < 60000) return medicosCache.lista;
    try {
      const d = await llamar("GET", "/api/integracion/medicos");
      medicosCache = { t: Date.now(), lista: (d && d.medicos) || [] };
    } catch (e) { medicosCache.t = Date.now() - 50000; }   // reintenta en 10 s
    return medicosCache.lista;
  }

  // ---------- rutas para la pantalla ----------
  const rutas = [
    // Médicos del centro (usuarios del PACS con perfil «Médicos solicitantes»)
    ["GET", /^\/api\/medicos$/, "sesion", async () => [200, await medicos()]],
    // Nueva clave del paciente (si la olvidó). La anterior deja de funcionar.
    ["POST", /^\/api\/citas\/(\d+)\/clave$/, "escribir", async (req, u, url, m) => {
      const c = db.prepare("SELECT * FROM citas WHERE id = ?").get(Number(m[1]));
      if (!c) fallo(404, "La cita ya no existe.");
      if (!ACTIVA) fallo(400, "La agenda aún no está conectada al PACS.");
      const clave = cambiarClave(c.rut, u.id);
      return [200, { clave, portal_url: PORTAL_URL, accesion: c.accesion }];
    }],
    // Ver la clave del paciente (solo administrador). Cada vez que alguien la ve queda registrado.
    ["GET", /^\/api\/citas\/(\d+)\/clave$/, "admin", async (req, u, url, m) => {
      const c = db.prepare("SELECT * FROM citas WHERE id = ?").get(Number(m[1]));
      if (!c) fallo(404, "La cita ya no existe.");
      const r = normRut(c.rut);
      const fila = r ? db.prepare(`SELECT p.clave_cifrada, p.creado, us.nombre AS creada_por FROM portal_claves p
        LEFT JOIN usuarios us ON us.id = p.usuario_id WHERE p.rut = ?`).get(r) : null;
      if (!fila) fallo(404, "Este paciente aún no tiene clave. Se crea al pagar, o con «Nueva clave».");
      const clave = descifrar(fila.clave_cifrada);
      if (!clave) fallo(409, "Esta clave se creó antes de que se pudieran ver (o en otro servidor), así que no se puede mostrar. Genera una nueva con «Nueva clave».");
      db.prepare("INSERT INTO portal_claves_vistas (rut, cita_id, usuario_id, visto) VALUES (?,?,?,?)").run(r, c.id, u.id, ahoraCaja());
      return [200, { clave, creado: fila.creado, creada_por: fila.creada_por || "", portal_url: PORTAL_URL }];
    }],
    // Estado de la conexión con el PACS (para el administrador)
    ["GET", /^\/api\/integracion$/, "sesion", async () => {
      const p = db.prepare("SELECT COUNT(*) AS n, MAX(intentos) AS max, MAX(error) AS error FROM pacs_cola").get();
      return [200, { activa: ACTIVA, portal_url: PORTAL_URL, pendientes: p.n, ultimo_ok: ultimoOk, error: ultimoError || (p.max ? p.error : "") }];
    }],
  ];

  return { activa: ACTIVA, resincronizar, portalUrl: PORTAL_URL, get pacsPublico() { return ACTIVA ? (PACS_PUBLICO || pacsDelPacs) : ""; }, avisar, avisarEliminada, asegurarClave, rutas, normRut, rutValido };
};
