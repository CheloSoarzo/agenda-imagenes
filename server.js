// Agenda de Imágenes — servidor web sin dependencias (Node.js 22.13 o superior)
// Inicio: npm start
// Variables opcionales: PORT, HOST, DATA_DIR, ADMIN_CLAVE, SESION_HORAS, COOKIE_SECURE=1, TRUST_PROXY=1, CENTRO_NOMBRE
// Conexión con el PACS (ver integracion.js): PACS_URL, INTEGRACION_TOKEN, PORTAL_URL, ACCESION_PREFIJO
// Módulo clínico (ver clinica.js): agendas de médicos, ficha clínica, recetas, documentos y horarios de atención.
// Módulos apagados por defecto: la agenda funciona exactamente igual y su base de datos no cambia.
// Se encienden desde la agenda (Administrador → Módulos); MODULO_CLINICO / MODULO_TURNOS (1 o 0) en el servidor los fijan.
// Con el módulo encendido: AGENDAS_EQUIPOS, CENTRO_DIRECCION, CENTRO_TELEFONO, PUBLIC_URL
// Usuario «raxio» (proveedor): solo él enciende o apaga módulos. El servidor entrega la huella de su clave,
// CLAVE_PROVEEDOR_HASH (sha256 de "raxio:" + clave; la genera el dueño con: pacs clave-proveedor). Sin ella, bloqueados.
// Turnos (ver turnos.js): tótem de números, pantalla de llamado (con videos) y panel de turnos.
// Independiente del módulo clínico. Opcional: VIDEOS_MAX_MB
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const db = require("./db");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const SESION_HORAS = Number(process.env.SESION_HORAS) || 12;
const COOKIE = "agenda_sesion";
const { resumenCaja, hoyCaja, CAJA_TZ, configTarjetas, guardarTarjetas, iniciarUF } = require("./caja");
iniciarUF();   // valor de la UF para la comisión fija de las tarjetas
const CENTRO = txtEnv(process.env.CENTRO_NOMBRE); // nombre del centro que se muestra en pantalla
function txtEnv(v) { return String(v || "").trim().slice(0, 60); }
// Logo del centro: CENTRO_LOGO (archivo en public/logos) o, si no se indica, el que coincide con el nombre del centro
const LOGO = (() => {
  const dir = path.join(__dirname, "public", "logos");
  let archivos = [];
  try { archivos = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|svg|webp)$/i.test(f)); } catch {}
  const pedido = txtEnv(process.env.CENTRO_LOGO);
  const clave = (pedido || CENTRO).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const f = archivos.find((a) => a.toLowerCase() === clave) || (clave && archivos.find((a) => clave.includes(a.toLowerCase().replace(/\.[a-z]+$/, ""))));
  return f ? "/logos/" + f : "";
})();
const PUBLIC = path.join(__dirname, "public");
// Versión del sistema (package.json) que se muestra al pie de cada página
const VERSION = (() => { try { return require("./package.json").version || "1.0.0"; } catch { return "1.0.0"; } })();

// ---------- primer usuario ----------
if (db.prepare("SELECT COUNT(*) AS n FROM usuarios").get().n === 0) {
  const clave = process.env.ADMIN_CLAVE || crypto.randomBytes(6).toString("base64url");
  db.prepare("INSERT INTO usuarios (usuario, nombre, clave_hash, rol) VALUES (?,?,?,?)")
    .run("admin", "Administrador", db.hashClave(clave), "admin");
  console.log("\n==============================================");
  console.log(" Usuario inicial creado");
  console.log("   usuario: admin");
  console.log("   clave:   " + clave);
  console.log(" Cámbiala apenas entres (Cambiar clave).");
  console.log("==============================================\n");
}

// ---------- utilidades ----------
const plain = (o) => (o ? { ...o } : o);
const plainAll = (a) => a.map(plain);
const txt = (v, max) => String(v ?? "").trim().slice(0, max);
// Nombres de exámenes siempre en MAYÚSCULAS (así se ven en los equipos y en el PACS)
const mayus = (v) => String(v ?? "").toLocaleUpperCase("es-CL");
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

function enviarJSON(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}
class ErrorHttp extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fallo = (status, msg) => { throw new ErrorHttp(status, msg); };

function leerCuerpo(req) {
  return new Promise((ok, mal) => {
    let datos = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { datos += c; if (datos.length > 100_000) { mal(new ErrorHttp(413, "La solicitud es demasiado grande.")); req.destroy(); } });
    req.on("end", () => { if (!datos) return ok({}); try { ok(JSON.parse(datos)); } catch { mal(new ErrorHttp(400, "Datos no válidos.")); } });
    req.on("error", mal);
  });
}
const MAX_ADJUNTO = 10 * 1024 * 1024; // 10 MB por archivo
function leerBinario(req, max) {
  return new Promise((ok, mal) => {
    const partes = []; let total = 0;
    req.on("data", (c) => { total += c.length; if (total > max) { mal(new ErrorHttp(413, "El archivo supera los 10 MB.")); req.destroy(); } else partes.push(c); });
    req.on("end", () => ok(Buffer.concat(partes)));
    req.on("error", mal);
  });
}
function leerCookie(req, nombre) {
  for (const parte of (req.headers.cookie || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}
const ipDe = (req) => (TRUST_PROXY && req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress;

// ---------- sesiones ----------
function usuarioDeSesion(req) {
  const token = leerCookie(req, COOKIE);
  if (!token) return null;
  const hash = sha(token);
  const s = db.prepare(`SELECT u.id, u.usuario, u.nombre, u.rol, u.agendas, u.paleta, s.expira FROM sesiones s
    JOIN usuarios u ON u.id = s.usuario_id WHERE s.token = ? AND u.activo = 1`).get(hash);
  if (!s || s.expira < Date.now()) return null;
  // El médico (módulo clínico) ve solo su propia agenda: la de su profesional vinculado
  const agendas = s.rol === "admin" ? "" : s.rol === "medico" ? (clin.agendasDeMedico(s.id).join(",") || "-") : (s.agendas || "");
  return { id: s.id, usuario: s.usuario, nombre: s.nombre, rol: s.rol, agendas, paleta: s.paleta || "", tokenHash: hash };
}
const intentos = new Map();
function frenoLogin(ip) {
  const ahora = Date.now();
  const r = intentos.get(ip) || { n: 0, desde: ahora };
  if (ahora - r.desde > 15 * 60e3) { r.n = 0; r.desde = ahora; }
  r.n++;
  intentos.set(ip, r);
  return r.n > 10;
}
const cookie = (valor, maxAge) =>
  `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? "; Secure" : ""}`;

// ---------- citas ----------
const EQUIPOS = ["tc", "rx", "eco"];
const ESTADOS = ["agendado", "confirmado", "llego", "atendido", "ausente", "cancelado"];

// Tiempo en sala: guarda cuándo la cita pasó a «En espera» (solo la primera vez);
// si vuelve a agendado o confirmado, se borra.
function marcarLlegada(id) {
  db.prepare(`UPDATE citas SET llego_en = CASE WHEN estado = 'llego' AND llego_en = '' THEN datetime('now')
    WHEN estado IN ('agendado','confirmado') THEN '' ELSE llego_en END WHERE id = ?`).run(id);
}
// Paletas de colores que puede elegir cada usuario (los colores están en public/estilos.css)
const PALETAS = ["azul", "rosa", "verde", "violeta", "cobre"];
// Módulos (clínico y turnos): se encienden desde la agenda (Administrador → Módulos) y quedan guardados en la base.
// Si el servidor define MODULO_CLINICO / MODULO_TURNOS (1 o 0), ese valor manda y el interruptor queda bloqueado.
const metaLeer = (k) => { try { return db.prepare("SELECT valor FROM meta WHERE clave = ?").get(k)?.valor; } catch { return undefined; } };
const metaPoner = (k, v) => db.prepare("INSERT INTO meta (clave, valor) VALUES (?,?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(k, String(v));
const envModulo = (v) => { const t = String(v ?? "").trim(); return t === "" ? null : /^(1|true|si|sí)$/i.test(t); };
const MOD_FIJO = { clinico: envModulo(process.env.MODULO_CLINICO), turnos: envModulo(process.env.MODULO_TURNOS) };
let CLINICO = MOD_FIJO.clinico ?? metaLeer("modulo_clinico") === "1";
let TURNOS = MOD_FIJO.turnos ?? metaLeer("modulo_turnos") === "1";
const ROLES = CLINICO ? ["admin", "recepcion", "lectura", "medico"] : ["admin", "recepcion", "lectura"];
// Roles que no agendan ni cobran (el médico trabaja en la ficha; agenda y caja son de recepción)
const SIN_ESCRITURA = ["lectura", "medico"];
const reFecha = /^\d{4}-\d{2}-\d{2}$/, reHora = /^([01]\d|2[0-3]):[0-5]\d$/;

function validarCita(b) {
  const c = {
    fecha: txt(b.fecha, 10), hora: txt(b.hora, 5), duracion: Math.round(Number(b.duracion)) || 15,
    equipo: txt(b.equipo, 5), paciente: txt(b.paciente, 120), rut: txt(b.rut, 20),
    telefono: txt(b.telefono, 30), examen: txt(b.examen, 160), prevision: txt(b.prevision, 40),
    medico: mayus(txt(b.medico, 120)), medico_id: Math.max(0, Math.round(Number(b.medico_id)) || 0), estado: txt(b.estado, 20) || "agendado", notas: txt(b.notas, 2000),
    fecha_nac: txt(b.fecha_nac, 10), email: txt(b.email, 120).toLowerCase(),
    telefono2: txt(b.telefono2, 30), email2: txt(b.email2, 120).toLowerCase(),
    codigo: "", valor: 0, bonificacion: 0, copago: 0, examenes: "",
  };
  if (!c.paciente) fallo(400, "Escribe el nombre del paciente.");
  // RUT: si se escribe, debe ser válido. Extranjeros sin RUT: se guarda «PAS » + su pasaporte o N° de documento.
  if (/^PAS\s/i.test(c.rut)) {
    const doc = c.rut.slice(4).trim().toUpperCase();
    if (doc.replace(/[^0-9A-Z]/g, "").length < 5) fallo(400, "Escribe el pasaporte o número de documento del paciente extranjero (al menos 5 letras o números).");
    c.rut = "PAS " + doc;
  } else if (c.rut && !integ.rutValido(c.rut)) {
    fallo(400, "El RUT no es válido. Revísalo, o marca «Paciente extranjero» si no tiene RUT.");
  }
  if (!reFecha.test(c.fecha)) fallo(400, "La fecha no es válida.");
  if (!reHora.test(c.hora)) fallo(400, "La hora no es válida.");
  if (!clin.esAgenda(c.equipo, true)) fallo(400, CLINICO ? "Elige una agenda." : "Elige un equipo.");
  if (!ESTADOS.includes(c.estado)) fallo(400, "El estado no es válido.");
  if (c.duracion < 5 || c.duracion > 240) fallo(400, "La duración debe estar entre 5 y 240 minutos.");
  if (c.fecha_nac && (!reFecha.test(c.fecha_nac) || c.fecha_nac > hoyCaja() || c.fecha_nac < "1900-01-01")) fallo(400, "La fecha de nacimiento no es válida.");
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email)) fallo(400, "El correo electrónico no es válido.");
  if (c.email2 && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email2)) fallo(400, "El segundo correo electrónico no es válido.");
  // Uno o varios exámenes (cada uno con su código y valores). Se aceptan también los campos sueltos de versiones anteriores.
  let lineas = Array.isArray(b.examenes) ? b.examenes : [{ codigo: b.codigo, nombre: b.examen, valor: b.valor, bonificacion: b.bonificacion }];
  if (lineas.length > 10) fallo(400, "Una cita puede tener hasta 10 exámenes.");
  // valor y bonificación llegan por unidad; con «cantidad» (mismo examen varias veces) se multiplican
  lineas = lineas.map((l) => {
    const cant = Math.min(20, Math.max(1, Math.round(Number(l?.cantidad)) || 1));
    const x = precioLinea({ codigo: txt(l?.codigo, 20), nombre: txt(l?.nombre ?? l?.examen, 160),
      valor: entero(l?.valor_unit ?? l?.valor), bonificacion: entero(l?.bonif_unit ?? l?.bonificacion) }, c.prevision);
    return { ...x, cantidad: cant, valor_unit: x.valor, bonif_unit: x.bonificacion,
      valor: x.valor * cant, bonificacion: x.bonificacion * cant, copago: x.copago * cant };
  }).filter((l) => l.codigo || l.nombre || l.valor);
  for (const l of lineas) l.nombre = mayus(l.nombre);
  const veces = (l) => (l.cantidad > 1 ? ` (X${l.cantidad})` : "");
  c.codigo = lineas.filter((l) => l.codigo).map((l) => l.codigo + (l.cantidad > 1 ? "x" + l.cantidad : "")).join("+");
  c.examen = lineas.filter((l) => l.nombre).map((l) => l.nombre + veces(l)).join(" + ").slice(0, 600);
  c.valor = lineas.reduce((t, l) => t + l.valor, 0);
  c.bonificacion = lineas.reduce((t, l) => t + l.bonificacion, 0);
  c.copago = c.valor - c.bonificacion;
  c.contraste = b.contraste === true || b.contraste === "si" || Number(b.contraste) > 0 ? CONTRASTE_VALOR : 0;
  c.examenes = lineas.length > 1 || lineas.some((l) => l.cantidad > 1) ? JSON.stringify(lineas) : "";
  return c;
}
// Montos en pesos: se ignoran puntos de miles, "$" y espacios
const entero = (v) => (typeof v === "number" ? Math.max(0, Math.round(v)) : Number(String(v ?? "").replace(/\D/g, "")) || 0);

// Valores de cada examen: con Fonasa se usan siempre los del arancel nivel 2;
// en las demás previsiones se respeta lo ingresado (por defecto el precio particular).
function precioLinea(l, prevision) {
  const a = l.codigo ? db.prepare("SELECT * FROM aranceles WHERE codigo = ?").get(l.codigo) : null;
  if (a && !l.nombre) l.nombre = a.nombre;
  if (prevision === "Fonasa" && a) {
    l.valor = a.fonasa_total; l.bonificacion = a.fonasa_bonif;
  } else if (prevision === "Particular") {
    if (!l.valor && a) l.valor = a.particular || a.fonasa_total;
    l.bonificacion = 0;
  }
  if (l.bonificacion > l.valor) fallo(400, `La bonificación no puede ser mayor que el valor${l.nombre ? " en " + l.nombre : ""}.`);
  l.copago = l.valor - l.bonificacion;
  return l;
}

// ---------- caja ----------
function ahoraCaja() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: CAJA_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const g = (t) => f.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}
const fechaCL = (iso) => String(iso).split("-").reverse().join("/");
const cajaCerrada = (fecha) => !!db.prepare("SELECT 1 FROM cierres WHERE fecha = ?").get(fecha);
const MEDIOS = ["Efectivo", "Débito", "Crédito", "Transferencia", "Cheque", "Sin copago"];

// Lee ?fecha= o ?desde=&hasta= (máximo un año)
function rangoCaja(url) {
  const fecha = url.searchParams.get("fecha");
  const desde = url.searchParams.get("desde") || fecha || hoyCaja();
  const hasta = url.searchParams.get("hasta") || fecha || desde;
  if (!reFecha.test(desde) || !reFecha.test(hasta)) fallo(400, "La fecha no es válida.");
  if (hasta < desde) fallo(400, "La fecha final es anterior a la inicial.");
  if ((new Date(hasta) - new Date(desde)) / 864e5 > 366) fallo(400, "El período no puede superar un año.");
  return [desde, hasta];
}
const agendasValidas = (v) => [...new Set(String(v || "").split(",").map((x) => x.trim()).filter((e) => clin.esAgenda(e)))].join(",");
// Agendas (equipos) que ve un usuario: [] = todas
// (un médico sin profesional vinculado no ve ninguna)
const agendasDe = (u) => { const a = String(u?.agendas || "").split(",").filter((e) => clin.esAgenda(e)); return !a.length && u?.rol === "medico" ? ["-"] : a; };
const veEquipo = (u, eq) => { const a = agendasDe(u); return !a.length || a.includes(eq); };
const filtroAgendas = (u, alias = "c") => { const a = agendasDe(u); return a.length ? ` AND ${alias}.equipo IN (${a.map((e) => `'${e}'`).join(",")})` : ""; };
// El usuario de solo lectura no ve valores ni pagos (sí si está pagada)
// Valor del medio de contraste (se cobra aparte del examen). Se puede cambiar con la variable CONTRASTE_VALOR.
const CONTRASTE_VALOR = Math.max(0, Math.round(Number(process.env.CONTRASTE_VALOR) || 25000));
const CAMPOS_DINERO = ["pago_contraste", "pago_boleta_contraste", "valor", "bonificacion", "copago", "pago_medio", "pago_monto", "pago_folio", "pago_descuento",
  "pago_desc_motivo", "pago_boleta", "pago_medio2", "pago_monto2", "pago_cheque"];
function paraUsuario(c, u) {
  if (!c || !SIN_ESCRITURA.includes(u?.rol)) return c;
  const x = { ...c };
  for (const k of CAMPOS_DINERO) delete x[k];
  try { if (x.examenes) x.examenes = JSON.stringify(JSON.parse(x.examenes).map((l) => ({ codigo: l.codigo, nombre: l.nombre, cantidad: l.cantidad }))); } catch { x.examenes = ""; }
  return x;
}
const SELECT_CITA = `SELECT c.*, uc.nombre AS creado_por_nombre, ua.nombre AS actualizado_por_nombre,
  (SELECT COUNT(*) FROM adjuntos a WHERE a.cita_id = c.id) AS adjuntos,
  p.id AS pago_id, p.medio AS pago_medio, p.copago AS pago_monto, p.medio2 AS pago_medio2, p.monto2 AS pago_monto2, p.folio_bono AS pago_folio, p.fecha AS pago_fecha,
  p.descuento AS pago_descuento, p.descuento_motivo AS pago_desc_motivo, p.boleta AS pago_boleta, p.cheque AS pago_cheque,
  p.contraste AS pago_contraste, p.boleta_contraste AS pago_boleta_contraste,
  p.creado AS pago_creado, up.nombre AS pago_usuario
  FROM citas c LEFT JOIN usuarios uc ON uc.id = c.creado_por LEFT JOIN usuarios ua ON ua.id = c.actualizado_por
  LEFT JOIN pagos p ON p.id = (SELECT MAX(id) FROM pagos WHERE cita_id = c.id AND anulado = 0)
  LEFT JOIN usuarios up ON up.id = p.usuario_id`;
// Integración con el PACS (órdenes, estados y clave del paciente). Inactiva si falta PACS_URL.
const integ = require("./integracion")(db, { ahoraCaja, hoyCaja, fallo, plain });
// Módulo clínico: solo con MODULO_CLINICO=1. Apagado, «clin» responde como la agenda de imágenes de siempre.
// Si un módulo no logra iniciar, la agenda sigue funcionando sin él (y queda el aviso en Administrador → Módulos).
function sinModulo(clave, e) {
  console.error(`No se pudo iniciar el módulo ${clave}; la agenda sigue sin él:`, e);
  try { metaPoner("modulo_" + clave, "0"); metaPoner("modulo_error", `${ahoraCaja()} · ${clave}: ${e && e.message || e}`); } catch {}
}
let clin = { activo: false, rutas: [], esAgenda: (e) => EQUIPOS.includes(e), esConsulta: () => false,
  esGrupoArancel: (e) => EQUIPOS.includes(e), agendasDeMedico: () => [] };
if (CLINICO) {
  try { clin = require("./clinica")(db, { ahoraCaja, hoyCaja, fallo, plain, txt, leerCuerpo, ipDe, integ, CENTRO, LOGO, VERSION }); }
  catch (e) { CLINICO = false; sinModulo("clinico", e); }
}
// Turnos: tótem, pantalla de llamado y llamado desde recepción o la ficha
let turn = { rutas: [] };
if (TURNOS) {
  try { turn = require("./turnos")(db, { ahoraCaja, hoyCaja, fallo, plain, txt, leerCuerpo, integ, clin, CENTRO, LOGO }); }
  catch (e) { TURNOS = false; sinModulo("turnos", e); }
}
// ---------- interruptores de módulos (Administrador → Módulos) ----------
const MODULOS = { clinico: "Ficha clínica y médicos", turnos: "Tótem y turnos" };
const PROVEEDOR_HASH = /^[0-9a-f]{64}$/i.test(String(process.env.CLAVE_PROVEEDOR_HASH || "").trim()) ? process.env.CLAVE_PROVEEDOR_HASH.trim().toLowerCase() : "";
const claveProveedorOk = (clave) => {
  if (!PROVEEDOR_HASH || !clave) return false;
  const h = crypto.createHash("sha256").update("raxio:" + String(clave)).digest();
  return crypto.timingSafeEqual(h, Buffer.from(PROVEEDOR_HASH, "hex"));
};
// Usuario «raxio» (proveedor): entra con la clave que genera el servidor (pacs clave-proveedor), es administrador,
// es el único que enciende o apaga módulos y no aparece en la lista de usuarios del centro.
const PROVEEDOR = "raxio";
const esProveedor = (u) => !!(PROVEEDOR_HASH && u && u.usuario === PROVEEDOR);
{
  const x = db.prepare("SELECT id FROM usuarios WHERE usuario = ?").get(PROVEEDOR);
  if (PROVEEDOR_HASH && !x) {
    db.prepare("INSERT INTO usuarios (usuario, nombre, clave_hash, rol) VALUES (?,?,?,?)")
      .run(PROVEEDOR, "Raxio (proveedor)", db.hashClave(crypto.randomBytes(24).toString("base64url")), "admin");
  } else if (PROVEEDOR_HASH && x) {
    db.prepare("UPDATE usuarios SET nombre = 'Raxio (proveedor)', rol = 'admin', activo = 1, eliminado = 0, agendas = '' WHERE id = ?").run(x.id);
  } else if (x) {
    // Sin clave de proveedor en el servidor, la cuenta queda desactivada
    db.prepare("UPDATE usuarios SET activo = 0 WHERE id = ?").run(x.id);
    db.prepare("DELETE FROM sesiones WHERE usuario_id = ?").run(x.id);
  }
}
const idProveedor = () => db.prepare("SELECT id FROM usuarios WHERE usuario = ?").get(PROVEEDOR)?.id || 0;
// El servidor lee este archivo para saber qué agendas tienen turnos (y permitirles subir videos grandes)
try { fs.writeFileSync(path.join(db.dataDir, "modulos.json"), JSON.stringify({ clinico: CLINICO, turnos: TURNOS }) + "\n"); } catch {}
const tablaExiste = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const normTxt = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
function estadoModulos() {
  let historial = [];
  try { historial = JSON.parse(metaLeer("modulos_historial") || "[]"); } catch {}
  const activo = { clinico: CLINICO, turnos: TURNOS };
  const m = {};
  for (const k of Object.keys(MODULOS)) {
    m[k] = { nombre: MODULOS[k], activo: activo[k], fijo: MOD_FIJO[k] !== null,
      guardado: metaLeer("modulo_" + k) === "1", iniciado: k === "clinico" ? tablaExiste("profesionales") : tablaExiste("turnos") };
  }
  return { centro: CENTRO, modulos: m, proveedor: !!PROVEEDOR_HASH, puede: false, historial: historial.slice(0, 20), error: metaLeer("modulo_error") || "" };
}
if (CLINICO && process.env.DEMO_DATOS === "true") require("./demo")(db, { ahoraCaja, hoyCaja });
const resp = require("./respaldo")(db, { ahoraCaja, fallo, integ });

const pagoActivo = (citaId) => db.prepare("SELECT * FROM pagos WHERE cita_id = ? AND anulado = 0").get(citaId);
const citaPorId = (id) => plain(db.prepare(`${SELECT_CITA} WHERE c.id = ?`).get(id));

// ================== AUDITORÍA DE LA AGENDA ==================
// Quién creó, modificó, cambió de estado, eliminó o cobró cada cita, los ingresos al sistema y los cambios de
// configuración. Solo se agrega (nunca se edita ni se borra desde la agenda). Lo ven los administradores.
db.exec(`CREATE TABLE IF NOT EXISTS bitacora (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  usuario_id INTEGER,
  usuario TEXT NOT NULL DEFAULT '',
  accion TEXT NOT NULL,
  cita_id INTEGER,
  paciente TEXT NOT NULL DEFAULT '',
  rut TEXT NOT NULL DEFAULT '',
  detalle TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_bitacora_fecha ON bitacora(fecha);
CREATE INDEX IF NOT EXISTS idx_bitacora_cita ON bitacora(cita_id);`);
const ACCIONES = {
  ingreso: "Ingresó al sistema", ingreso_fallido: "Intento de ingreso fallido", salida: "Salió del sistema",
  crear_cita: "Creó la cita", modificar_cita: "Modificó la cita", estado_cita: "Cambió el estado", eliminar_cita: "Eliminó la cita",
  cobro: "Registró el pago", anular_pago: "Anuló el pago", cerrar_caja: "Cerró la caja", reabrir_caja: "Reabrió la caja",
  adjunto: "Adjuntó un archivo", borrar_adjunto: "Borró un adjunto",
  crear_usuario: "Creó un usuario", modificar_usuario: "Modificó un usuario", eliminar_usuario: "Eliminó un usuario",
  respaldo: "Descargó un respaldo", cargar_respaldo: "Cargó un respaldo", modulo: "Cambió un módulo",
  clave_portal: "Clave del portal", aranceles: "Aranceles", descargar_auditoria: "Descargó la auditoría", otro: "Otro cambio",
};
const ESTADO_TXT = { agendado: "Agendado", confirmado: "Confirmado", llego: "En espera", atendido: "Atendido", ausente: "No asistió", cancelado: "Cancelado" };
const estadoTxt = (e) => ESTADO_TXT[e] || e;
const nombreUsuario = (u) => (u ? (u.nombre && u.nombre !== u.usuario ? `${u.nombre} (${u.usuario})` : u.usuario) : "");
function auditar(req, u, accion, { cita = null, detalle = "", usuario = null } = {}) {
  try {
    if (req) req._auditado = true;
    const c = typeof cita === "number" ? db.prepare("SELECT id, paciente, rut FROM citas WHERE id = ?").get(cita) : cita;
    db.prepare("INSERT INTO bitacora (fecha, usuario_id, usuario, accion, cita_id, paciente, rut, detalle, ip) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(ahoraCaja(), u ? u.id : null, usuario ?? nombreUsuario(u), accion, c ? c.id : (typeof cita === "number" ? cita : null),
        c ? c.paciente || "" : "", c ? c.rut || "" : "", String(detalle).slice(0, 4000), req ? ipDe(req) : "");
  } catch (e) { console.error("No se pudo registrar la auditoría:", e.message); }
}
// Qué cambió entre la cita anterior y la nueva («hora 10:00 → 11:30; estado agendado → llegó»)
const CAMPOS_CITA = [["fecha", "fecha"], ["hora", "hora"], ["duracion", "duración"], ["equipo", "agenda"], ["paciente", "paciente"],
  ["rut", "RUT"], ["telefono", "teléfono"], ["telefono2", "teléfono 2"], ["email", "correo"], ["email2", "correo 2"],
  ["fecha_nac", "fecha de nacimiento"], ["examen", "examen"], ["prevision", "previsión"], ["medico", "médico solicitante"],
  ["estado", "estado"], ["notas", "comentario"], ["valor", "valor"], ["copago", "copago"]];
const verCampo = (k, v) => (v === null || v === undefined || v === "" ? "(vacío)" : k === "fecha" || k === "fecha_nac" ? fechaCL(v) : k === "estado" ? estadoTxt(v) : String(v));
function cambiosCita(antes, despues) {
  const out = [];
  for (const [k, n] of CAMPOS_CITA) {
    if (!(k in despues)) continue;
    const a = antes[k] ?? "", d = despues[k] ?? "";
    if (String(a) !== String(d)) out.push(`${n}: ${verCampo(k, a)} → ${verCampo(k, d)}`);
  }
  return out.join("; ");
}
// Acciones que no se registran una por una en su ruta: se reconocen por la dirección
const OTRAS = [
  ["POST", /^\/api\/respaldo\/restaurar$/, "cargar_respaldo", () => "se reemplazaron los datos de la agenda por los del respaldo"],
  ["POST", /^\/api\/respaldo\/revisar$/, null],                              // solo revisa el archivo: no cambia nada
  ["GET", /^\/api\/citas\/(\d+)\/clave$/, "clave_portal", () => "vio la clave del paciente para el portal", 1],
  ["POST", /^\/api\/citas\/(\d+)\/clave$/, "clave_portal", () => "generó la clave del paciente para el portal", 1],
  ["POST", /^\/api\/citas\/(\d+)\/extranjero$/, "modificar_cita", () => "marcó al paciente como extranjero", 1],
  ["PUT", /^\/api\/aranceles\/([\w.-]+)$/, "aranceles", (m) => "modificó el arancel " + m[1]],
  ["POST", /^\/api\/aranceles/, "aranceles", () => "cambió los aranceles"],
  ["DELETE", /^\/api\/aranceles\/([\w.-]+)$/, "aranceles", (m) => "eliminó el arancel " + m[1]],
  ["PUT", /^\/api\/caja\/tarjetas$/, "otro", () => "cambió las comisiones de tarjetas"],
];
function registrarOtro(req, u, p) {
  for (const [met, re, accion, det, conCita] of OTRAS) {
    const m = req.method === met && p.match(re);
    if (!m) continue;
    if (accion) auditar(req, u, accion, { cita: conCita ? Number(m[1]) : null, detalle: det(m) });
    return;
  }
  if (req.method !== "GET") auditar(req, u, "otro", { detalle: `${req.method} ${p}` });
}
const resumenCita = (c) => `${fechaCL(c.fecha)} ${c.hora} · ${String(c.equipo || "").toUpperCase()}${c.examen ? " · " + c.examen : ""}${c.estado ? " · " + estadoTxt(c.estado) : ""}`;
// La cita debe ser de una agenda que el usuario puede ver
function exigirAgenda(u, citaId) {
  const c = db.prepare("SELECT equipo FROM citas WHERE id = ?").get(citaId);
  if (c && !veEquipo(u, c.equipo)) fallo(403, "Esa cita es de una agenda que tu usuario no ve.");
}

// ---------- rutas de la API ----------
// Cada ruta: [método, patrón, nivel ("libre" | "sesion" | "escribir" | "admin"), manejador]
const rutas = [
  ["POST", /^\/api\/login$/, "libre", async (req) => {
    const ip = ipDe(req);
    if (frenoLogin(ip)) fallo(429, "Demasiados intentos. Espera 15 minutos.");
    const { usuario, clave } = await leerCuerpo(req);
    const u = db.prepare("SELECT * FROM usuarios WHERE usuario = ? AND activo = 1").get(txt(usuario, 40));
    // El usuario «raxio» entra con la clave de proveedor del servidor (no con una clave guardada en la agenda)
    const ok = u && (u.usuario === PROVEEDOR ? claveProveedorOk(clave) : db.verificarClave(clave, u.clave_hash));
    if (!ok) {
      auditar(req, u && u.usuario !== PROVEEDOR ? u : null, "ingreso_fallido", { usuario: txt(usuario, 40), detalle: u ? "clave incorrecta" : "usuario inexistente o desactivado" });
      fallo(401, "Usuario o clave incorrectos.");
    }
    intentos.delete(ip);
    auditar(req, u, "ingreso");
    const token = crypto.randomBytes(32).toString("base64url");
    db.prepare("DELETE FROM sesiones WHERE expira < ?").run(Date.now());
    db.prepare("INSERT INTO sesiones (token, usuario_id, expira) VALUES (?,?,?)")
      .run(sha(token), u.id, Date.now() + SESION_HORAS * 3600e3);
    // Con el módulo clínico, los médicos parten en su ficha (sin el módulo la respuesta no cambia)
    const destino = CLINICO && u.rol === "medico" ? { ir: "/ficha" } : {};
    return [200, { ok: true, ...destino }, { "Set-Cookie": cookie(token, SESION_HORAS * 3600) }];
  }],

  ["POST", /^\/api\/logout$/, "libre", async (req) => {
    const u = usuarioDeSesion(req);
    if (u) { db.prepare("DELETE FROM sesiones WHERE token = ?").run(u.tokenHash); auditar(req, u, "salida"); }
    return [200, { ok: true }, { "Set-Cookie": cookie("", 0) }];
  }],

  ["GET", /^\/api\/me$/, "sesion", async (req, u) => {
    const { tokenHash, ...datos } = u;
    const extra = CLINICO || TURNOS ? { turnos: TURNOS || undefined } : {};
    if (CLINICO) Object.assign(extra, { clinico: true, profesional: u.rol === "medico" ? plain(db.prepare(
      "SELECT id, nombre, titulo, especialidad FROM profesionales WHERE usuario_id = ? AND activo = 1 ORDER BY id LIMIT 1").get(u.id)) || null : null });
    if (esProveedor(u)) extra.proveedor = true;
    return [200, { ...datos, centro: CENTRO, logo: LOGO, pacs: integ.activa, portal_url: integ.portalUrl, pacs_publico: integ.pacsPublico, version: VERSION, contraste_valor: CONTRASTE_VALOR, ...extra }];
  }],

  ["GET", /^\/api\/config$/, "libre", async () => [200, { centro: CENTRO, logo: LOGO, pacs: integ.activa, portal_url: integ.portalUrl, version: VERSION, contraste_valor: CONTRASTE_VALOR }]],

  // Citas de un día (?fecha=) o de un rango (?desde=&hasta=, máximo 31 días)
  ["GET", /^\/api\/citas$/, "sesion", async (req, u, url) => {
    const fecha = url.searchParams.get("fecha") || "";
    const desde = url.searchParams.get("desde") || fecha, hasta = url.searchParams.get("hasta") || fecha;
    if (!reFecha.test(desde) || !reFecha.test(hasta) || hasta < desde) fallo(400, "Falta la fecha.");
    if ((new Date(hasta) - new Date(desde)) / 864e5 > 31) fallo(400, "El rango no puede superar 31 días.");
    return [200, plainAll(db.prepare(`${SELECT_CITA} WHERE c.fecha BETWEEN ? AND ?${filtroAgendas(u)} ORDER BY c.fecha, c.hora`)
      .all(desde, hasta)).map((c) => paraUsuario(c, u))];
  }],

  // ----- adjuntos (orden médica) -----
  ["GET", /^\/api\/citas\/(\d+)\/adjuntos$/, "sesion", async (req, u, url, m) => exigirAgenda(u, Number(m[1])) ||
    [200, plainAll(db.prepare(`SELECT a.id, a.nombre, a.tipo, a.tamano, a.creado, us.nombre AS usuario_nombre,
      '/api/adjuntos/' || a.id AS url FROM adjuntos a LEFT JOIN usuarios us ON us.id = a.usuario_id
      WHERE a.cita_id = ? ORDER BY a.id`).all(Number(m[1])))]],

  ["POST", /^\/api\/citas\/(\d+)\/adjuntos$/, "escribir", async (req, u, url, m) => {
    const id = Number(m[1]);
    exigirAgenda(u, id);
    if (!db.prepare("SELECT 1 FROM citas WHERE id = ?").get(id)) fallo(404, "La cita ya no existe.");
    const tipo = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(tipo)) fallo(400, "Solo se pueden adjuntar fotos (JPG, PNG) o PDF.");
    const datos = await leerBinario(req, MAX_ADJUNTO);
    if (!datos.length) fallo(400, "El archivo está vacío.");
    // comprobar que el contenido corresponde al tipo declarado
    const firma = datos.subarray(0, 4).toString("hex");
    const ok = (tipo === "application/pdf" && datos.subarray(0, 4).toString() === "%PDF") || (tipo === "image/jpeg" && firma.startsWith("ffd8"))
      || (tipo === "image/png" && firma === "89504e47") || (tipo === "image/webp" && datos.subarray(8, 12).toString() === "WEBP");
    if (!ok) fallo(400, "El archivo no es una imagen o PDF válido.");
    const nombre = txt(decodeURIComponent(url.searchParams.get("nombre") || ""), 120) || "orden";
    const r = db.prepare("INSERT INTO adjuntos (cita_id, nombre, tipo, tamano, datos, usuario_id, creado) VALUES (?,?,?,?,?,?,?)")
      .run(id, nombre, tipo, datos.length, datos, u.id, ahoraCaja());
    auditar(req, u, "adjunto", { cita: id, detalle: `${nombre} (${Math.round(datos.length / 1024)} KB)` });
    return [201, { id: Number(r.lastInsertRowid), url: "/api/adjuntos/" + r.lastInsertRowid }];
  }],

  ["GET", /^\/api\/adjuntos\/(\d+)$/, "sesion", async (req, u, url, m) => {
    const a = db.prepare("SELECT nombre, tipo, datos FROM adjuntos WHERE id = ?").get(Number(m[1]));
    if (!a) fallo(404, "El archivo ya no existe.");
    const ext = a.tipo === "application/pdf" ? ".pdf" : a.tipo === "image/png" ? ".png" : a.tipo === "image/webp" ? ".webp" : ".jpg";
    const nombre = (a.nombre.replace(/\.[a-z0-9]{2,4}$/i, "") || "orden").replace(/[^\w\- ]+/g, "_") + ext;
    return ["RAW", Buffer.from(a.datos), { "Content-Type": a.tipo, "Content-Disposition": `inline; filename="${nombre}"`,
      "Cache-Control": "private, max-age=3600", "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; plugin-types application/pdf" }];
  }],

  ["DELETE", /^\/api\/adjuntos\/(\d+)$/, "escribir", async (req, u, url, m) => {
    const adj = db.prepare("SELECT cita_id, nombre FROM adjuntos WHERE id = ?").get(Number(m[1]));
    db.prepare("DELETE FROM adjuntos WHERE id = ?").run(Number(m[1]));
    if (adj) auditar(req, u, "borrar_adjunto", { cita: adj.cita_id, detalle: adj.nombre });
    return [200, { ok: true }];
  }],

  // Resumen del mes para el calendario: citas y minutos ocupados por día y equipo
  ["GET", /^\/api\/citas\/mes$/, "sesion", async (req, u, url) => {
    const mes = url.searchParams.get("mes") || "";
    if (!/^\d{4}-\d{2}$/.test(mes)) fallo(400, "Falta el mes.");
    return [200, plainAll(db.prepare(`SELECT fecha, equipo, COUNT(*) AS n, SUM(duracion) AS minutos FROM citas c
      WHERE fecha LIKE ? AND estado != 'cancelado'${filtroAgendas(u)} GROUP BY fecha, equipo`).all(mes + "-%"))];
  }],

  // Datos del paciente según su RUT (de su última cita), para no volver a escribirlos
  ["GET", /^\/api\/paciente$/, "sesion", async (req, u, url) => {
    const rut = txt(url.searchParams.get("rut"), 20);
    const limpio = rut.replace(/[^0-9kK]/g, "").toUpperCase();
    if (limpio.length < 7) return [200, null];
    const p = db.prepare(`SELECT paciente, rut, telefono, telefono2, fecha_nac, email, email2, prevision FROM citas
      WHERE UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')) = ? ORDER BY fecha DESC, id DESC LIMIT 1`).get(limpio);
    return [200, plain(p) || null];
  }],

  ["GET", /^\/api\/buscar$/, "sesion", async (req, u, url) => {
    const q = txt(url.searchParams.get("q"), 60).replace(/[%_]/g, "");
    if (q.length < 2) return [200, []];
    const like = "%" + q + "%";
    return [200, plainAll(db.prepare(`${SELECT_CITA} WHERE (c.paciente LIKE ? OR c.rut LIKE ?)${filtroAgendas(u)}
      ORDER BY c.fecha DESC, c.hora DESC LIMIT 30`).all(like, like)).map((c) => paraUsuario(c, u))];
  }],

  ["POST", /^\/api\/citas$/, "escribir", async (req, u) => {
    const cuerpo = await leerCuerpo(req);
    const c = validarCita(cuerpo);
    if (!veEquipo(u, c.equipo)) fallo(403, "Tu usuario no puede agendar en esa agenda.");
    const sobrecupo = CLINICO ? clin.revisarHorario(c, cuerpo, null) : 0;   // médicos: horario de atención y bloqueos
    const r = db.prepare(`INSERT INTO citas (fecha,hora,duracion,equipo,paciente,rut,telefono,telefono2,fecha_nac,email,email2,examen,prevision,medico,medico_id,estado,notas,codigo,valor,bonificacion,copago,examenes,contraste,creado_por,actualizado_por)
      VALUES (@fecha,@hora,@duracion,@equipo,@paciente,@rut,@telefono,@telefono2,@fecha_nac,@email,@email2,@examen,@prevision,@medico,@medico_id,@estado,@notas,@codigo,@valor,@bonificacion,@copago,@examenes,@contraste,@uid,@uid)`)
      .run({ ...c, uid: u.id });
    const nuevoId = Number(r.lastInsertRowid);
    if (sobrecupo) db.prepare("UPDATE citas SET sobrecupo = 1 WHERE id = ?").run(nuevoId);
    auditar(req, u, "crear_cita", { cita: nuevoId, detalle: resumenCita(c) + (sobrecupo ? " · SOBRECUPO" : "") });
    db.prepare("UPDATE citas SET accesion = ? WHERE id = ?").run(db.accesionDe(nuevoId), nuevoId);
    marcarLlegada(nuevoId);
    integ.avisar(nuevoId);
    return [201, citaPorId(nuevoId)];
  }],

  ["PUT", /^\/api\/citas\/(\d+)$/, "escribir", async (req, u, url, m) => {
    const id = Number(m[1]);
    exigirAgenda(u, id);
    const cuerpo = await leerCuerpo(req);
    const c = validarCita(cuerpo);
    if (!veEquipo(u, c.equipo)) fallo(403, "Tu usuario no puede agendar en esa agenda.");
    const antes = db.prepare("SELECT * FROM citas WHERE id = ?").get(id);
    const sobrecupo = CLINICO ? clin.revisarHorario(c, cuerpo, db.prepare("SELECT fecha, hora, duracion, equipo, sobrecupo FROM citas WHERE id = ?").get(id)) : 0;
    // Si ya está pagada, los datos de cobro quedan fijos (para cambiarlos hay que anular el pago)
    const pago = pagoActivo(id);
    if (pago) {
      const prev = db.prepare("SELECT codigo, examen, prevision, valor, bonificacion, copago, examenes, contraste FROM citas WHERE id = ?").get(id);
      Object.assign(c, plain(prev));
      // Si la cita pagada cambia de día, el pago se mueve con ella a la caja del nuevo día
      if (pago.fecha !== c.fecha) {
        if (cajaCerrada(pago.fecha)) fallo(409, `Esta cita está pagada y la caja del ${fechaCL(pago.fecha)} ya está cerrada. Un administrador debe reabrirla para cambiarla de día.`);
        if (cajaCerrada(c.fecha)) fallo(409, `Esta cita está pagada y la caja del ${fechaCL(c.fecha)} ya está cerrada. Un administrador debe reabrirla para moverla a ese día.`);
      }
    }
    const r = db.prepare(`UPDATE citas SET fecha=@fecha,hora=@hora,duracion=@duracion,equipo=@equipo,paciente=@paciente,rut=@rut,
      telefono=@telefono,telefono2=@telefono2,fecha_nac=@fecha_nac,email=@email,email2=@email2,examen=@examen,prevision=@prevision,medico=@medico,medico_id=@medico_id,estado=@estado,notas=@notas,
      codigo=@codigo,valor=@valor,bonificacion=@bonificacion,copago=@copago,examenes=@examenes,contraste=@contraste,
      actualizado_por=@uid,actualizado=datetime('now') WHERE id=@id`).run({ ...c, uid: u.id, id });
    if (!r.changes) fallo(404, "La cita ya no existe.");
    if (CLINICO) db.prepare("UPDATE citas SET sobrecupo = ? WHERE id = ?").run(sobrecupo, id);
    if (antes) { const dif = cambiosCita(antes, c); if (dif || (sobrecupo && !antes.sobrecupo)) auditar(req, u, "modificar_cita", { cita: id, detalle: (dif || "") + (sobrecupo && !antes.sobrecupo ? (dif ? "; " : "") + "SOBRECUPO" : "") }); }
    marcarLlegada(id);
    if (pago && pago.fecha !== c.fecha) db.prepare("UPDATE pagos SET fecha = ? WHERE cita_id = ? AND anulado = 0").run(c.fecha, id);
    integ.avisar(id);
    return [200, citaPorId(id)];
  }],

  // Cambiar solo el estado de la cita (también lo pueden hacer los usuarios de solo lectura)
  ["PUT", /^\/api\/citas\/(\d+)\/estado$/, "sesion", async (req, u, url, m) => {
    const id = Number(m[1]);
    exigirAgenda(u, id);
    const estado = txt((await leerCuerpo(req)).estado, 20);
    if (!ESTADOS.includes(estado)) fallo(400, "El estado no es válido.");
    const previo = db.prepare("SELECT estado FROM citas WHERE id = ?").get(id);
    const r = db.prepare("UPDATE citas SET estado = ?, actualizado_por = ?, actualizado = datetime('now') WHERE id = ?").run(estado, u.id, id);
    if (r.changes && previo && previo.estado !== estado) auditar(req, u, "estado_cita", { cita: id, detalle: `${estadoTxt(previo.estado)} → ${estadoTxt(estado)}` });
    if (!r.changes) fallo(404, "La cita ya no existe.");
    marcarLlegada(id);
    integ.avisar(id);
    return [200, paraUsuario(citaPorId(id), u)];
  }],

  ["DELETE", /^\/api\/citas\/(\d+)$/, "escribir", async (req, u, url, m) => {
    exigirAgenda(u, Number(m[1]));
    if (pagoActivo(Number(m[1]))) fallo(409, "Esta cita tiene un pago registrado. Anula el pago antes de eliminarla.");
    const borrada = db.prepare("SELECT * FROM citas WHERE id = ?").get(Number(m[1]));
    integ.avisarEliminada(Number(m[1]));
    db.prepare("DELETE FROM citas WHERE id = ?").run(Number(m[1]));
    if (borrada) auditar(req, u, "eliminar_cita", { cita: { id: borrada.id, paciente: borrada.paciente, rut: borrada.rut },
      detalle: resumenCita(borrada) + (borrada.telefono ? " · tel. " + borrada.telefono : "") + (borrada.notas ? " · comentario: " + borrada.notas : "") });
    return [200, { ok: true }];
  }],

  // ----- pagos -----
  ["POST", /^\/api\/citas\/(\d+)\/pago$/, "escribir", async (req, u, url, m) => {
    const id = Number(m[1]);
    exigirAgenda(u, id);
    const b = await leerCuerpo(req);
    const c = db.prepare("SELECT * FROM citas WHERE id = ?").get(id);
    if (!c) fallo(404, "La cita ya no existe.");
    if (pagoActivo(id)) fallo(409, "Esta cita ya tiene un pago registrado.");
    if (!c.valor) fallo(400, "Elige el examen y su valor antes de cobrar.");
    if (!(/^PAS\s/i.test(c.rut || "") || integ.rutValido(c.rut))) fallo(400, c.rut
      ? "El RUT de esta cita no es válido. Corrígelo en «Editar cita» (o marca «Paciente extranjero») antes de cobrar."
      : "Falta el RUT del paciente (o su pasaporte si es extranjero). Escríbelo en «Editar cita» antes de cobrar.");
    // El pago se registra en la caja del día agendado (no en el día en que se cobra)
    const fecha = c.fecha;
    if (cajaCerrada(fecha)) fallo(409, `La caja del ${fechaCL(fecha)} ya está cerrada. Un administrador debe reabrirla para registrar pagos.`);
    // Descuento sobre el copago del paciente (la bonificación del bono no cambia)
    const tipoDesc = txt(b.descuento_tipo, 10), motivoDesc = txt(b.descuento_motivo, 120);
    let descuento = 0, detalle = "";
    if (tipoDesc === "pct") {
      const pct = Math.min(100, Math.max(0, Number(String(b.descuento_valor ?? "").replace(",", ".")) || 0));
      descuento = Math.round(c.copago * pct / 100); detalle = `${String(pct).replace(".", ",")}%`;
    } else if (tipoDesc === "monto") {
      descuento = entero(b.descuento_valor); detalle = "monto";
    } else if (tipoDesc) fallo(400, "Tipo de descuento no válido.");
    if (descuento < 0 || descuento > c.copago) fallo(400, "El descuento no puede ser mayor que el copago.");
    if (descuento > 0 && !motivoDesc) fallo(400, "Escribe el motivo del descuento.");
    if (!descuento) detalle = "";
    const contraste = c.contraste || 0;                  // medio de contraste: aparte del examen, sin descuento ni bonificación
    const aPagar = c.copago - descuento + contraste;
    const medio = aPagar === 0 ? "Sin copago" : txt(b.medio, 20);
    if (!MEDIOS.includes(medio)) fallo(400, "Elige el medio de pago.");
    // Segundo medio de pago (opcional): monto2 con medio2, el resto con el primero
    let medio2 = txt(b.medio2, 20), monto2 = entero(b.monto2);
    if (!medio2 || !monto2 || aPagar === 0) { medio2 = ""; monto2 = 0; }
    else {
      if (!MEDIOS.includes(medio2) || medio2 === "Sin copago") fallo(400, "Elige el segundo medio de pago.");
      if (medio2 === medio) fallo(400, "El segundo medio de pago debe ser distinto del primero.");
      if (monto2 >= aPagar) fallo(400, "El monto del segundo medio debe ser menor que el total a pagar.");
    }
    const folio = txt(b.folio_bono, 40), boleta = txt(b.boleta, 40), boletaContraste = contraste ? txt(b.boleta_contraste, 40) : "";
    const cheque = medio === "Cheque" || medio2 === "Cheque" ? txt(b.cheque, 80) : "";
    if ((medio === "Cheque" || medio2 === "Cheque") && !cheque) fallo(400, "Escribe el número del cheque y el banco.");
    if (c.prevision === "Fonasa" && c.bonificacion > 0 && !folio) fallo(400, "Ingresa el folio del bono Fonasa.");
    db.prepare(`INSERT INTO pagos (cita_id, fecha, paciente, rut, equipo, codigo, examen, prevision, valor, bonificacion, copago, medio, folio_bono, usuario_id, creado,
      descuento, descuento_motivo, descuento_detalle, examenes, boleta, medio2, monto2, cheque, contraste, boleta_contraste)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, fecha, c.paciente, c.rut, c.equipo, c.codigo, c.examen, c.prevision,
      c.valor, c.bonificacion, aPagar, medio, folio, u.id, ahoraCaja(), descuento, descuento ? motivoDesc : "", detalle, c.examenes || "", boleta,
      medio2, monto2, cheque, contraste, boletaContraste);
    if (["agendado", "confirmado"].includes(c.estado)) db.prepare("UPDATE citas SET estado = 'llego' WHERE id = ?").run(id);
    marcarLlegada(id);
    // Clave para ver el examen en línea: se crea al pagar (solo la primera vez que viene el paciente)
    // (las consultas médicas no van al PACS ni crean clave del portal de exámenes)
    const portal = integ.activa && !clin.esConsulta(c.equipo) ? { ...integ.asegurarClave(c.rut, u.id), url: integ.portalUrl } : null;
    integ.avisar(id);
    auditar(req, u, "cobro", { cita: id, detalle: `$${Number(aPagar).toLocaleString("es-CL")} · ${medio}${medio2 ? ` + ${medio2} $${Number(monto2).toLocaleString("es-CL")}` : ""}${descuento ? ` · descuento $${Number(descuento).toLocaleString("es-CL")} (${motivoDesc})` : ""}${boleta ? " · boleta " + boleta : ""}` });
    return [201, { ...citaPorId(id), portal }];
  }],

  ["POST", /^\/api\/pagos\/(\d+)\/anular$/, "escribir", async (req, u, url, m) => {
    const b = await leerCuerpo(req);
    const p = db.prepare("SELECT * FROM pagos WHERE id = ?").get(Number(m[1]));
    if (!p || p.anulado) fallo(404, "El pago no existe o ya fue anulado.");
    if (cajaCerrada(p.fecha)) fallo(409, "La caja de ese día ya está cerrada. Un administrador debe reabrirla.");
    if (u.rol !== "admin" && p.usuario_id !== u.id) fallo(403, "Solo quien registró el pago o un administrador puede anularlo.");
    const motivo = txt(b.motivo, 200);
    if (!motivo) fallo(400, "Escribe el motivo de la anulación.");
    db.prepare("UPDATE pagos SET anulado = 1, anulado_por = ?, motivo_anulacion = ? WHERE id = ?").run(u.id, motivo, p.id);
    auditar(req, u, "anular_pago", { cita: p.cita_id ? { id: p.cita_id, paciente: p.paciente, rut: p.rut } : null,
      detalle: `$${Number(p.copago).toLocaleString("es-CL")} · ${p.medio} · del ${fechaCL(p.fecha)} · motivo: ${motivo}` });
    if (p.cita_id) integ.avisar(p.cita_id);
    return [200, { ok: true }];
  }],

  // ----- caja -----
  ["GET", /^\/api\/caja$/, "caja", async (req, u, url) => [200, resumenCaja(...rangoCaja(url))]],

  ["POST", /^\/api\/caja\/cerrar$/, "escribir", async (req, u) => {
    const b = await leerCuerpo(req);
    const fecha = txt(b.fecha, 10);
    if (!reFecha.test(fecha)) fallo(400, "La fecha no es válida.");
    if (fecha > hoyCaja()) fallo(400, "No puedes cerrar una caja de un día futuro.");
    if (cajaCerrada(fecha)) fallo(409, "La caja de ese día ya está cerrada.");
    if (b.efectivo_contado === undefined || b.efectivo_contado === "") fallo(400, "Ingresa el efectivo contado en caja.");
    const r = resumenCaja(fecha);
    const contado = entero(b.efectivo_contado);
    db.prepare("INSERT INTO cierres (fecha, usuario_id, resumen, efectivo_contado, diferencia, observaciones, creado) VALUES (?,?,?,?,?,?,?)")
      .run(fecha, u.id, JSON.stringify(r.totales), contado, contado - r.totales.efectivo_esperado, txt(b.observaciones, 1000), ahoraCaja());
    auditar(req, u, "cerrar_caja", { detalle: `caja del ${fechaCL(fecha)} · efectivo contado $${contado.toLocaleString("es-CL")} · diferencia $${(contado - r.totales.efectivo_esperado).toLocaleString("es-CL")}` });
    return [200, resumenCaja(fecha)];
  }],

  ["GET", /^\/api\/caja\/tarjetas$/, "caja", async () => [200, configTarjetas()]],
  ["PUT", /^\/api\/caja\/tarjetas$/, "admin", async (req) => {
    try { return [200, guardarTarjetas(await leerCuerpo(req))]; } catch (e) { fallo(400, "Revisa los valores de comisión."); }
  }],
  ["POST", /^\/api\/caja\/reabrir$/, "admin", async (req, u) => {
    const b = await leerCuerpo(req);
    const rc = db.prepare("DELETE FROM cierres WHERE fecha = ?").run(txt(b.fecha, 10));
    if (rc.changes) auditar(req, u, "reabrir_caja", { detalle: `caja del ${fechaCL(txt(b.fecha, 10))}` });
    return [200, resumenCaja(txt(b.fecha, 10))];
  }],

  ["GET", /^\/api\/caja\/csv$/, "caja", async (req, u, url) => {
    const [desde, hasta] = rangoCaja(url);
    const r = resumenCaja(desde, hasta);
    const esc = (v) => { const t = String(v ?? ""); return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const filas = [["Fecha", "Hora", "Paciente", "RUT", "Equipo", "Código", "Examen", "Previsión", "Valor", "Bonificación", "Descuento", "Motivo descuento", "Pagado", "Medio", "Folio bono", "Boleta", "Cajero", "Estado"]];
    for (const p of r.pagos) filas.push([p.fecha.split("-").reverse().join("/"), p.creado.slice(11, 16), p.paciente, p.rut, p.equipo.toUpperCase(), p.codigo, p.examen, p.prevision,
      p.valor, p.bonificacion, p.descuento, p.descuento_motivo, p.copago, p.medio_txt, p.folio_bono, p.boleta, p.usuario_nombre, p.anulado ? "ANULADO: " + p.motivo_anulacion : "OK"]);
    filas.push([]);
    filas.push(["Total atenciones", r.totales.atenciones]);
    filas.push(["Total valor", r.totales.valor]);
    filas.push(["Total bonificación", r.totales.bonificacion]);
    filas.push(["Total descuentos", r.totales.descuentos]);
    filas.push(["Total recaudado", r.totales.recaudado]);
    for (const [k, v] of Object.entries(r.totales.por_medio)) filas.push(["Recaudado " + k, v.copago]);
    if (r.cierre) { filas.push(["Efectivo contado", r.cierre.efectivo_contado]); filas.push(["Diferencia", r.cierre.diferencia]); }
    const csv = "\ufeff" + filas.map((f) => f.map(esc).join(";")).join("\r\n");
    return ["RAW", csv, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="caja-${desde === hasta ? desde : desde + "_a_" + hasta}.csv"` }];
  }],

  // ----- aranceles -----
  ["GET", /^\/api\/aranceles$/, "sesion", async () =>
    [200, plainAll(db.prepare("SELECT * FROM aranceles ORDER BY equipo, codigo").all())]],

  ["PUT", /^\/api\/aranceles\/([\w.-]{1,20})$/, "admin", async (req, u, url, m) => {
    const b = await leerCuerpo(req);
    const a = { codigo: m[1], nombre: mayus(txt(b.nombre, 200)), equipo: txt(b.equipo, 5), fonasa_total: entero(b.fonasa_total),
      fonasa_bonif: entero(b.fonasa_bonif), particular: entero(b.particular), activo: b.activo === false || b.activo === 0 ? 0 : 1 };
    if (!a.nombre) fallo(400, "Escribe el nombre de la prestación.");
    if (!clin.esGrupoArancel(a.equipo)) fallo(400, CLINICO ? "Elige el equipo o «Consultas»." : "Elige el equipo.");
    if (a.fonasa_bonif > a.fonasa_total) fallo(400, "La bonificación no puede ser mayor que el valor.");
    db.prepare(`INSERT INTO aranceles (codigo, nombre, equipo, fonasa_total, fonasa_bonif, particular, activo)
      VALUES (@codigo,@nombre,@equipo,@fonasa_total,@fonasa_bonif,@particular,@activo)
      ON CONFLICT(codigo) DO UPDATE SET nombre=@nombre, equipo=@equipo, fonasa_total=@fonasa_total,
      fonasa_bonif=@fonasa_bonif, particular=@particular, activo=@activo`).run(a);
    return [200, { ok: true }];
  }],

  // ----- respaldo: copia completa y consistente de la base de datos -----
  // ----- auditoría de la agenda (solo administradores) -----
  ["GET", /^\/api\/bitacora$/, "admin", async (req, u, url) => {
    const q = (k) => txt(url.searchParams.get(k), 80);
    const desde = reFecha.test(q("desde")) ? q("desde") : hoyCaja(), hasta = reFecha.test(q("hasta")) ? q("hasta") : desde;
    const where = ["fecha >= ? AND fecha < ?"], args = [desde, hasta + " 99"];
    if (q("usuario")) { where.push("usuario_id = ?"); args.push(Number(q("usuario"))); }
    if (q("accion") && ACCIONES[q("accion")]) { where.push("accion = ?"); args.push(q("accion")); }
    if (q("q")) {
      const t = q("q"), limpio = t.replace(/[^0-9kK]/g, "").toUpperCase();
      where.push("(paciente LIKE ? OR detalle LIKE ?" + (limpio.length >= 6 ? " OR UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')) LIKE ?" : "") + ")");
      args.push("%" + t + "%", "%" + t + "%"); if (limpio.length >= 6) args.push("%" + limpio + "%");
    }
    const filas = plainAll(db.prepare(`SELECT * FROM bitacora WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 5000`).all(...args))
      .map((f) => ({ ...f, accion_txt: ACCIONES[f.accion] || f.accion }));
    if (url.searchParams.get("csv") === "1") {
      auditar(req, u, "descargar_auditoria", { detalle: `del ${fechaCL(desde)} al ${fechaCL(hasta)}` });
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lineas = [["Fecha", "Hora", "Usuario", "Acción", "Paciente", "RUT", "Detalle", "IP"].map(esc).join(";")]
        .concat(filas.map((f) => [fechaCL(f.fecha.slice(0, 10)), f.fecha.slice(11, 16), f.usuario, f.accion_txt, f.paciente, f.rut, f.detalle, f.ip].map(esc).join(";")));
      return ["RAW", Buffer.from("\ufeff" + lineas.join("\r\n"), "utf8"), { "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="auditoria-agenda-${desde}-al-${hasta}.csv"` }];
    }
    const usuarios = plainAll(db.prepare("SELECT id, usuario, nombre FROM usuarios WHERE usuario <> ? ORDER BY nombre").all(PROVEEDOR));
    return [200, { filas, acciones: ACCIONES, usuarios, limite: filas.length >= 5000 }];
  }],
  ["GET", /^\/api\/citas\/(\d+)\/historial$/, "admin", async (req, u, url, m) =>
    [200, plainAll(db.prepare("SELECT * FROM bitacora WHERE cita_id = ? ORDER BY id").all(Number(m[1]))).map((f) => ({ ...f, accion_txt: ACCIONES[f.accion] || f.accion }))]],

  ["GET", /^\/api\/respaldo$/, "admin", async (req, u) => {
    auditar(req, u, "respaldo", { detalle: "copia completa de la base de datos" });
    const tmp = path.join(os.tmpdir(), `respaldo-${process.pid}-${Date.now()}.db`);
    try {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const datos = fs.readFileSync(tmp);
      const sello = ahoraCaja().replace(/[: ]/g, "-").slice(0, 16);
      return ["RAW", datos, { "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="agenda-respaldo-${sello}.db"`, "Content-Length": datos.length }];
    } finally { fs.rm(tmp, { force: true }, () => {}); }
  }],

  ["GET", /^\/api\/usuarios$/, "admin", async () =>
    [200, plainAll(db.prepare("SELECT id, usuario, nombre, rol, activo, agendas, creado FROM usuarios WHERE eliminado = 0 AND usuario <> ? ORDER BY nombre").all(PROVEEDOR))]],

  ["POST", /^\/api\/usuarios$/, "admin", async (req, admin) => {
    const b = await leerCuerpo(req);
    const usuario = txt(b.usuario, 40).toLowerCase(), nombre = txt(b.nombre, 80), clave = String(b.clave || ""), rol = txt(b.rol, 20);
    if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) fallo(400, "El usuario debe tener 3 o más letras o números, sin espacios.");
    if (clave.length < 8) fallo(400, "La clave debe tener al menos 8 caracteres.");
    if (!ROLES.includes(rol)) fallo(400, "Elige un rol.");
    if (usuario === PROVEEDOR) fallo(409, "Ese nombre de usuario está reservado.");
    if (db.prepare("SELECT 1 FROM usuarios WHERE usuario = ?").get(usuario)) fallo(409, "Ese usuario ya existe.");
    db.prepare("INSERT INTO usuarios (usuario, nombre, clave_hash, rol, agendas) VALUES (?,?,?,?,?)")
      .run(usuario, nombre || usuario, db.hashClave(clave), rol, agendasValidas(b.agendas));
    auditar(req, admin, "crear_usuario", { detalle: `${nombre || usuario} (${usuario}) · rol ${rol}${b.agendas ? " · agendas " + agendasValidas(b.agendas) : ""}` });
    return [201, { ok: true }];
  }],

  ["PUT", /^\/api\/usuarios\/(\d+)$/, "sesion", async (req, u, url, m) => {
    const id = Number(m[1]), esAdmin = u.rol === "admin";
    if (!esAdmin && id !== u.id) fallo(403, "Solo puedes cambiar tu propia clave.");
    if (id === idProveedor() && id !== u.id) fallo(404, "Ese usuario no existe.");
    const b = await leerCuerpo(req);
    if (b.clave !== undefined && id === idProveedor()) fallo(400, "La clave de Raxio se cambia en el servidor (pacs clave-proveedor).");
    if (b.clave !== undefined) {
      if (String(b.clave).length < 8) fallo(400, "La clave debe tener al menos 8 caracteres.");
      db.prepare("UPDATE usuarios SET clave_hash = ? WHERE id = ?").run(db.hashClave(b.clave), id);
    }
    if (esAdmin && b.rol !== undefined) {
      if (!ROLES.includes(b.rol)) fallo(400, "Rol no válido.");
      if (id === u.id && b.rol !== "admin") fallo(400, "No puedes quitarte el rol de administrador.");
      db.prepare("UPDATE usuarios SET rol = ? WHERE id = ?").run(b.rol, id);
    }
    if (b.paleta !== undefined) {
      if (id !== u.id) fallo(403, "Cada usuario elige sus propios colores.");
      if (!PALETAS.includes(b.paleta)) fallo(400, "Esa paleta no existe.");
      db.prepare("UPDATE usuarios SET paleta = ? WHERE id = ?").run(b.paleta === "azul" ? "" : b.paleta, id);
    }
    if (esAdmin && b.agendas !== undefined) db.prepare("UPDATE usuarios SET agendas = ? WHERE id = ?").run(agendasValidas(b.agendas), id);
    {
      const x = db.prepare("SELECT usuario, nombre FROM usuarios WHERE id = ?").get(id);
      const cambios = [b.clave !== undefined && "clave", esAdmin && b.rol !== undefined && "rol " + b.rol,
        esAdmin && b.agendas !== undefined && "agendas " + (agendasValidas(b.agendas) || "todas"),
        esAdmin && b.activo !== undefined && (b.activo ? "activado" : "desactivado")].filter(Boolean);
      if (x && cambios.length) auditar(req, u, "modificar_usuario", { detalle: `${x.nombre} (${x.usuario}) · ${cambios.join(", ")}` });
    }
    if (esAdmin && b.activo !== undefined) {
      if (id === u.id) fallo(400, "No puedes desactivar tu propio usuario.");
      db.prepare("UPDATE usuarios SET activo = ? WHERE id = ?").run(b.activo ? 1 : 0, id);
      if (!b.activo) db.prepare("DELETE FROM sesiones WHERE usuario_id = ?").run(id);
    }
    return [200, { ok: true }];
  }],

  // Eliminar usuario: ya no entra ni aparece, y su nombre de usuario queda libre.
  // No se borra de la base para que la caja y las citas sigan mostrando quién cobró o agendó.
  ["DELETE", /^\/api\/usuarios\/(\d+)$/, "admin", async (req, u, url, m) => {
    const id = Number(m[1]);
    if (id === u.id) fallo(400, "No puedes eliminar tu propio usuario.");
    if (id === idProveedor()) fallo(404, "Ese usuario ya no existe.");
    const x = db.prepare("SELECT * FROM usuarios WHERE id = ? AND eliminado = 0").get(id);
    if (!x) fallo(404, "Ese usuario ya no existe.");
    db.prepare("UPDATE usuarios SET eliminado = 1, activo = 0, usuario = ? WHERE id = ?").run(`${x.usuario}~eliminado${id}`, id);
    auditar(req, u, "eliminar_usuario", { detalle: `${x.nombre} (${x.usuario})` });
    db.prepare("DELETE FROM sesiones WHERE usuario_id = ?").run(id);
    return [200, { ok: true }];
  }],
  ...integ.rutas,
  ["GET", /^\/api\/modulos$/, "admin", async (req, u) => [200, { ...estadoModulos(), puede: esProveedor(u) }]],
  ["PUT", /^\/api\/modulos$/, "admin", async (req, u) => {
    const b = await leerCuerpo(req);
    const k = String(b.modulo || "");
    if (!MODULOS[k]) fallo(400, "Módulo no válido.");
    // Solo el proveedor (usuario «raxio») enciende o apaga módulos: los administradores del centro solo ven qué está incluido
    if (!esProveedor(u)) fallo(403, "Solo Raxio puede encender o apagar módulos. Contacte a Raxio.");
    if (MOD_FIJO[k] !== null) fallo(409, `Este módulo lo fija la configuración del servidor (MODULO_${k.toUpperCase()}). Para cambiarlo desde aquí, hay que quitar esa variable.`);
    const activar = b.activo === true;
    const est = estadoModulos().modulos[k];
    if (est.guardado === activar && est.activo === activar) return [200, { ...estadoModulos(), puede: true, reinicio: false }];
    // La primera vez que se enciende la ficha clínica se pide escribir el nombre del centro (cambia la base de datos)
    if (activar && k === "clinico" && !est.iniciado) {
      const esperado = normTxt(CENTRO || "ACTIVAR");
      if (normTxt(b.confirmacion) !== esperado) fallo(400, `Para encender la ficha clínica escribe «${CENTRO || "ACTIVAR"}».`);
    }
    metaPoner("modulo_" + k, activar ? "1" : "0");
    db.prepare("DELETE FROM meta WHERE clave = 'modulo_error'").run();
    let historial = [];
    try { historial = JSON.parse(metaLeer("modulos_historial") || "[]"); } catch {}
    historial.unshift({ fecha: ahoraCaja(), usuario: u.nombre || u.usuario, modulo: MODULOS[k], activo: activar });
    metaPoner("modulos_historial", JSON.stringify(historial.slice(0, 50)));
    auditar(req, u, "modulo", { detalle: `${activar ? "encendió" : "apagó"} «${MODULOS[k]}»` });
    console.log(`Módulo «${MODULOS[k]}» ${activar ? "encendido" : "apagado"} por ${u.usuario}. La agenda se reinicia para aplicarlo.`);
    // La agenda se reinicia sola (Docker la vuelve a levantar en segundos) y arranca con el módulo nuevo
    setTimeout(() => process.exit(0), 700);
    return [200, { ...estadoModulos(), puede: true, reinicio: true }];
  }],
  ...clin.rutas,
  ...turn.rutas,
  ...resp.rutas,
];

// ---------- archivos ----------
const TIPOS = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
function enviarArchivo(res, archivo) {
  const ruta = path.join(PUBLIC, archivo);
  if (!ruta.startsWith(PUBLIC + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(ruta, (err, datos) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("No encontrado"); }
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(ruta)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(datos);
  });
}

// ---------- servidor ----------
const servidor = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    if (p.startsWith("/api/")) {
      for (const [metodo, patron, nivel, manejador] of rutas) {
        const m = p.match(patron);
        if (!m || req.method !== metodo) continue;
        let u = null;
        if (nivel !== "libre") {
          u = usuarioDeSesion(req);
          if (!u) fallo(401, "Tu sesión expiró. Vuelve a ingresar.");
          if ((nivel === "escribir" || nivel === "caja") && SIN_ESCRITURA.includes(u.rol)) fallo(403, u.rol === "medico" ? "La agenda y la caja las maneja recepción." : "Tu usuario es solo de lectura.");
          if (nivel === "admin" && u.rol !== "admin") fallo(403, "Solo un administrador puede hacer esto.");
        }
        const [status, data, headers] = await manejador(req, u, url, m);
        // Cualquier otro cambio que no quedó registrado arriba queda como «Otro cambio» (método y ruta)
        if (u && !req._auditado && status < 400) registrarOtro(req, u, p);
        if (status === "RAW") { res.writeHead(200, { "Cache-Control": "no-store", ...headers }); return res.end(data); }
        return enviarJSON(res, status, data, headers);
      }
      fallo(404, "Ruta no encontrada.");
    }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    if (p === "/") {
      if (!usuarioDeSesion(req)) { res.writeHead(302, { Location: "/login" }); return res.end(); }
      return enviarArchivo(res, "index.html");
    }
    if (p === "/login") return enviarArchivo(res, "login.html");
    // Módulo clínico: ficha (médicos), profesionales (administrador) y verificación pública de documentos
    if (/^\/(ficha|profesionales)(\.html)?$/.test(p) && !CLINICO) { res.writeHead(404); return res.end(); }
    if (CLINICO && (p === "/ficha" || p === "/profesionales")) {
      if (!usuarioDeSesion(req)) { res.writeHead(302, { Location: "/login" }); return res.end(); }
      return enviarArchivo(res, p.slice(1) + ".html");
    }
    // Turnos: tótem y pantalla sin usuario (entran con la clave de dispositivo ?k= que valida la API)
    if (/^\/(totem|pantalla|turnos)(\.html)?$/.test(p) && !TURNOS) { res.writeHead(404); return res.end(); }
    if (TURNOS && (p === "/totem" || p === "/pantalla")) return enviarArchivo(res, p.slice(1) + ".html");
    if (TURNOS && p.startsWith("/videos/")) return turn.servirVideo(req, res, url);
    if (TURNOS && p === "/turnos") {
      if (!usuarioDeSesion(req)) { res.writeHead(302, { Location: "/login" }); return res.end(); }
      return enviarArchivo(res, "turnos.html");
    }
    if (CLINICO && (p === "/verificar" || p.startsWith("/verificar/"))) {
      const html = clin.paginaVerificar(req, p.length > 11 ? decodeURIComponent(p.slice(11)) : url.searchParams.get("c"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
      return res.end(html);
    }
    return enviarArchivo(res, decodeURIComponent(p).replace(/^\/+/, ""));
  } catch (e) {
    if (e instanceof ErrorHttp) return enviarJSON(res, e.status, { error: e.message });
    console.error(e);
    return enviarJSON(res, 500, { error: "Ocurrió un error en el servidor." });
  }
});

// Con turnos, subir videos a la pantalla puede tardar varios minutos: se da más tiempo al cuerpo de la petición
if (TURNOS) servidor.requestTimeout = 30 * 60 * 1000;
servidor.listen(PORT, HOST, () => console.log(`Agenda de Imágenes en http://localhost:${PORT}`));
