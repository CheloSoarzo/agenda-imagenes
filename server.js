// Agenda de Imágenes — servidor web sin dependencias (Node.js 22.13 o superior)
// Inicio: npm start
// Variables opcionales: PORT, HOST, DATA_DIR, ADMIN_CLAVE, SESION_HORAS, COOKIE_SECURE=1, TRUST_PROXY=1, CENTRO_NOMBRE
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
const CAJA_TZ = process.env.CAJA_TZ || "America/Santiago";
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
  const s = db.prepare(`SELECT u.id, u.usuario, u.nombre, u.rol, s.expira FROM sesiones s
    JOIN usuarios u ON u.id = s.usuario_id WHERE s.token = ? AND u.activo = 1`).get(hash);
  if (!s || s.expira < Date.now()) return null;
  return { id: s.id, usuario: s.usuario, nombre: s.nombre, rol: s.rol, tokenHash: hash };
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
const ROLES = ["admin", "recepcion", "lectura"];
const reFecha = /^\d{4}-\d{2}-\d{2}$/, reHora = /^([01]\d|2[0-3]):[0-5]\d$/;

function validarCita(b) {
  const c = {
    fecha: txt(b.fecha, 10), hora: txt(b.hora, 5), duracion: Math.round(Number(b.duracion)) || 15,
    equipo: txt(b.equipo, 5), paciente: txt(b.paciente, 120), rut: txt(b.rut, 20),
    telefono: txt(b.telefono, 30), examen: txt(b.examen, 160), prevision: txt(b.prevision, 40),
    medico: txt(b.medico, 120), estado: txt(b.estado, 20) || "agendado", notas: txt(b.notas, 2000),
    fecha_nac: txt(b.fecha_nac, 10), email: txt(b.email, 120).toLowerCase(),
    codigo: "", valor: 0, bonificacion: 0, copago: 0, examenes: "",
  };
  if (!c.paciente) fallo(400, "Escribe el nombre del paciente.");
  if (!reFecha.test(c.fecha)) fallo(400, "La fecha no es válida.");
  if (!reHora.test(c.hora)) fallo(400, "La hora no es válida.");
  if (!EQUIPOS.includes(c.equipo)) fallo(400, "Elige un equipo.");
  if (!ESTADOS.includes(c.estado)) fallo(400, "El estado no es válido.");
  if (c.duracion < 5 || c.duracion > 240) fallo(400, "La duración debe estar entre 5 y 240 minutos.");
  if (c.fecha_nac && (!reFecha.test(c.fecha_nac) || c.fecha_nac > hoyCaja() || c.fecha_nac < "1900-01-01")) fallo(400, "La fecha de nacimiento no es válida.");
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email)) fallo(400, "El correo electrónico no es válido.");
  // Uno o varios exámenes (cada uno con su código y valores). Se aceptan también los campos sueltos de versiones anteriores.
  let lineas = Array.isArray(b.examenes) ? b.examenes : [{ codigo: b.codigo, nombre: b.examen, valor: b.valor, bonificacion: b.bonificacion }];
  if (lineas.length > 10) fallo(400, "Una cita puede tener hasta 10 exámenes.");
  lineas = lineas.map((l) => precioLinea({ codigo: txt(l?.codigo, 20), nombre: txt(l?.nombre ?? l?.examen, 160),
    valor: entero(l?.valor), bonificacion: entero(l?.bonificacion) }, c.prevision))
    .filter((l) => l.codigo || l.nombre || l.valor);
  c.codigo = lineas.map((l) => l.codigo).filter(Boolean).join("+");
  c.examen = lineas.map((l) => l.nombre).filter(Boolean).join(" + ").slice(0, 600);
  c.valor = lineas.reduce((t, l) => t + l.valor, 0);
  c.bonificacion = lineas.reduce((t, l) => t + l.bonificacion, 0);
  c.copago = c.valor - c.bonificacion;
  c.examenes = lineas.length > 1 ? JSON.stringify(lineas) : "";
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
function hoyCaja() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CAJA_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
const cajaCerrada = (fecha) => !!db.prepare("SELECT 1 FROM cierres WHERE fecha = ?").get(fecha);
const MEDIOS = ["Efectivo", "Débito", "Crédito", "Transferencia", "Sin copago"];

// Resumen de caja de un día o de un período (desde–hasta, ambos incluidos)
function resumenCaja(desde, hasta = desde) {
  const pagos = plainAll(db.prepare(`SELECT p.*, u.nombre AS usuario_nombre, ua.nombre AS anulado_por_nombre
    FROM pagos p LEFT JOIN usuarios u ON u.id = p.usuario_id LEFT JOIN usuarios ua ON ua.id = p.anulado_por
    WHERE p.fecha BETWEEN ? AND ? ORDER BY p.fecha, p.creado`).all(desde, hasta));
  const validos = pagos.filter((p) => !p.anulado);
  const suma = (arr, k) => arr.reduce((t, p) => t + (p[k] || 0), 0);
  const agrupar = (clave, lista) => {
    const o = {};
    for (const p of lista) { const k = p[clave] || "Sin dato"; o[k] = o[k] || { cantidad: 0, valor: 0, bonificacion: 0, copago: 0 };
      o[k].cantidad++; o[k].valor += p.valor; o[k].bonificacion += p.bonificacion; o[k].copago += p.copago; o[k].descuento = (o[k].descuento || 0) + (p.descuento || 0); }
    return o;
  };
  const totales = {
    atenciones: validos.length,
    valor: suma(validos, "valor"),
    bonificacion: suma(validos, "bonificacion"),
    recaudado: suma(validos, "copago"),
    descuentos: suma(validos, "descuento"),
    con_descuento: validos.filter((p) => p.descuento > 0).length,
    por_descuento: agrupar("descuento_motivo", validos.filter((p) => p.descuento > 0)),
    anulados: pagos.length - validos.length,
    por_medio: agrupar("medio", validos),
    por_prevision: agrupar("prevision", validos),
    por_equipo: agrupar("equipo", validos),
    efectivo_esperado: validos.filter((p) => p.medio === "Efectivo").reduce((t, p) => t + p.copago, 0),
  };
  const cierres = plainAll(db.prepare(`SELECT c.*, u.nombre AS usuario_nombre FROM cierres c LEFT JOIN usuarios u ON u.id = c.usuario_id
    WHERE c.fecha BETWEEN ? AND ? ORDER BY c.fecha`).all(desde, hasta)).map((c) => ({ ...c, resumen: JSON.parse(c.resumen) }));
  // Detalle por día (para períodos de varios días)
  const dias = {};
  for (const p of validos) {
    const d = (dias[p.fecha] = dias[p.fecha] || { fecha: p.fecha, atenciones: 0, valor: 0, bonificacion: 0, descuentos: 0, recaudado: 0, efectivo_esperado: 0 });
    d.atenciones++; d.valor += p.valor; d.bonificacion += p.bonificacion; d.descuentos += p.descuento || 0; d.recaudado += p.copago;
    if (p.medio === "Efectivo") d.efectivo_esperado += p.copago;
  }
  for (const c of cierres) dias[c.fecha] = dias[c.fecha] || { fecha: c.fecha, atenciones: 0, valor: 0, bonificacion: 0, descuentos: 0, recaudado: 0, efectivo_esperado: 0 };
  const por_dia = Object.values(dias).sort((a, b) => a.fecha.localeCompare(b.fecha)).map((d) => {
    const c = cierres.find((x) => x.fecha === d.fecha);
    return { ...d, cerrada: !!c, efectivo_contado: c ? c.efectivo_contado : null, diferencia: c ? c.diferencia : null, cerrada_por: c ? c.usuario_nombre : null };
  });
  totales.diferencias = cierres.reduce((t, c) => t + c.diferencia, 0);
  const cierre = desde === hasta ? cierres[0] || null : null;
  return { fecha: desde, desde, hasta, un_dia: desde === hasta, hoy: hoyCaja(), pagos, totales, cierre, cierres, por_dia };
}
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
const SELECT_CITA = `SELECT c.*, uc.nombre AS creado_por_nombre, ua.nombre AS actualizado_por_nombre,
  (SELECT COUNT(*) FROM adjuntos a WHERE a.cita_id = c.id) AS adjuntos,
  p.id AS pago_id, p.medio AS pago_medio, p.copago AS pago_monto, p.folio_bono AS pago_folio, p.fecha AS pago_fecha,
  p.descuento AS pago_descuento, p.descuento_motivo AS pago_desc_motivo, p.boleta AS pago_boleta,
  p.creado AS pago_creado, up.nombre AS pago_usuario
  FROM citas c LEFT JOIN usuarios uc ON uc.id = c.creado_por LEFT JOIN usuarios ua ON ua.id = c.actualizado_por
  LEFT JOIN pagos p ON p.id = (SELECT MAX(id) FROM pagos WHERE cita_id = c.id AND anulado = 0)
  LEFT JOIN usuarios up ON up.id = p.usuario_id`;
const pagoActivo = (citaId) => db.prepare("SELECT * FROM pagos WHERE cita_id = ? AND anulado = 0").get(citaId);
const citaPorId = (id) => plain(db.prepare(`${SELECT_CITA} WHERE c.id = ?`).get(id));

// ---------- rutas de la API ----------
// Cada ruta: [método, patrón, nivel ("libre" | "sesion" | "escribir" | "admin"), manejador]
const rutas = [
  ["POST", /^\/api\/login$/, "libre", async (req) => {
    const ip = ipDe(req);
    if (frenoLogin(ip)) fallo(429, "Demasiados intentos. Espera 15 minutos.");
    const { usuario, clave } = await leerCuerpo(req);
    const u = db.prepare("SELECT * FROM usuarios WHERE usuario = ? AND activo = 1").get(txt(usuario, 40));
    if (!u || !db.verificarClave(clave, u.clave_hash)) fallo(401, "Usuario o clave incorrectos.");
    intentos.delete(ip);
    const token = crypto.randomBytes(32).toString("base64url");
    db.prepare("DELETE FROM sesiones WHERE expira < ?").run(Date.now());
    db.prepare("INSERT INTO sesiones (token, usuario_id, expira) VALUES (?,?,?)")
      .run(sha(token), u.id, Date.now() + SESION_HORAS * 3600e3);
    return [200, { ok: true }, { "Set-Cookie": cookie(token, SESION_HORAS * 3600) }];
  }],

  ["POST", /^\/api\/logout$/, "libre", async (req) => {
    const u = usuarioDeSesion(req);
    if (u) db.prepare("DELETE FROM sesiones WHERE token = ?").run(u.tokenHash);
    return [200, { ok: true }, { "Set-Cookie": cookie("", 0) }];
  }],

  ["GET", /^\/api\/me$/, "sesion", async (req, u) => {
    const { tokenHash, ...datos } = u;
    return [200, { ...datos, centro: CENTRO, logo: LOGO }];
  }],

  ["GET", /^\/api\/config$/, "libre", async () => [200, { centro: CENTRO, logo: LOGO }]],

  // Citas de un día (?fecha=) o de un rango (?desde=&hasta=, máximo 31 días)
  ["GET", /^\/api\/citas$/, "sesion", async (req, u, url) => {
    const fecha = url.searchParams.get("fecha") || "";
    const desde = url.searchParams.get("desde") || fecha, hasta = url.searchParams.get("hasta") || fecha;
    if (!reFecha.test(desde) || !reFecha.test(hasta) || hasta < desde) fallo(400, "Falta la fecha.");
    if ((new Date(hasta) - new Date(desde)) / 864e5 > 31) fallo(400, "El rango no puede superar 31 días.");
    return [200, plainAll(db.prepare(`${SELECT_CITA} WHERE c.fecha BETWEEN ? AND ? ORDER BY c.fecha, c.hora`).all(desde, hasta))];
  }],

  // ----- adjuntos (orden médica) -----
  ["GET", /^\/api\/citas\/(\d+)\/adjuntos$/, "sesion", async (req, u, url, m) =>
    [200, plainAll(db.prepare(`SELECT a.id, a.nombre, a.tipo, a.tamano, a.creado, us.nombre AS usuario_nombre,
      '/api/adjuntos/' || a.id AS url FROM adjuntos a LEFT JOIN usuarios us ON us.id = a.usuario_id
      WHERE a.cita_id = ? ORDER BY a.id`).all(Number(m[1])))]],

  ["POST", /^\/api\/citas\/(\d+)\/adjuntos$/, "escribir", async (req, u, url, m) => {
    const id = Number(m[1]);
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
    db.prepare("DELETE FROM adjuntos WHERE id = ?").run(Number(m[1]));
    return [200, { ok: true }];
  }],

  // Resumen del mes para el calendario: citas y minutos ocupados por día y equipo
  ["GET", /^\/api\/citas\/mes$/, "sesion", async (req, u, url) => {
    const mes = url.searchParams.get("mes") || "";
    if (!/^\d{4}-\d{2}$/.test(mes)) fallo(400, "Falta el mes.");
    return [200, plainAll(db.prepare(`SELECT fecha, equipo, COUNT(*) AS n, SUM(duracion) AS minutos FROM citas
      WHERE fecha LIKE ? AND estado != 'cancelado' GROUP BY fecha, equipo`).all(mes + "-%"))];
  }],

  // Datos del paciente según su RUT (de su última cita), para no volver a escribirlos
  ["GET", /^\/api\/paciente$/, "sesion", async (req, u, url) => {
    const rut = txt(url.searchParams.get("rut"), 20);
    const limpio = rut.replace(/[^0-9kK]/g, "").toUpperCase();
    if (limpio.length < 7) return [200, null];
    const p = db.prepare(`SELECT paciente, rut, telefono, fecha_nac, email, prevision FROM citas
      WHERE UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')) = ? ORDER BY fecha DESC, id DESC LIMIT 1`).get(limpio);
    return [200, plain(p) || null];
  }],

  ["GET", /^\/api\/buscar$/, "sesion", async (req, u, url) => {
    const q = txt(url.searchParams.get("q"), 60).replace(/[%_]/g, "");
    if (q.length < 2) return [200, []];
    const like = "%" + q + "%";
    return [200, plainAll(db.prepare(`${SELECT_CITA} WHERE c.paciente LIKE ? OR c.rut LIKE ?
      ORDER BY c.fecha DESC, c.hora DESC LIMIT 30`).all(like, like))];
  }],

  ["POST", /^\/api\/citas$/, "escribir", async (req, u) => {
    const c = validarCita(await leerCuerpo(req));
    const r = db.prepare(`INSERT INTO citas (fecha,hora,duracion,equipo,paciente,rut,telefono,fecha_nac,email,examen,prevision,medico,estado,notas,codigo,valor,bonificacion,copago,examenes,creado_por,actualizado_por)
      VALUES (@fecha,@hora,@duracion,@equipo,@paciente,@rut,@telefono,@fecha_nac,@email,@examen,@prevision,@medico,@estado,@notas,@codigo,@valor,@bonificacion,@copago,@examenes,@uid,@uid)`)
      .run({ ...c, uid: u.id });
    return [201, citaPorId(Number(r.lastInsertRowid))];
  }],

  ["PUT", /^\/api\/citas\/(\d+)$/, "escribir", async (req, u, url, m) => {
    const id = Number(m[1]);
    const c = validarCita(await leerCuerpo(req));
    // Si ya está pagada, los datos de cobro quedan fijos (para cambiarlos hay que anular el pago)
    if (pagoActivo(id)) {
      const prev = db.prepare("SELECT codigo, examen, prevision, valor, bonificacion, copago, examenes FROM citas WHERE id = ?").get(id);
      Object.assign(c, plain(prev));
    }
    const r = db.prepare(`UPDATE citas SET fecha=@fecha,hora=@hora,duracion=@duracion,equipo=@equipo,paciente=@paciente,rut=@rut,
      telefono=@telefono,fecha_nac=@fecha_nac,email=@email,examen=@examen,prevision=@prevision,medico=@medico,estado=@estado,notas=@notas,
      codigo=@codigo,valor=@valor,bonificacion=@bonificacion,copago=@copago,examenes=@examenes,
      actualizado_por=@uid,actualizado=datetime('now') WHERE id=@id`).run({ ...c, uid: u.id, id });
    if (!r.changes) fallo(404, "La cita ya no existe.");
    return [200, citaPorId(id)];
  }],

  ["DELETE", /^\/api\/citas\/(\d+)$/, "escribir", async (req, u, url, m) => {
    if (pagoActivo(Number(m[1]))) fallo(409, "Esta cita tiene un pago registrado. Anula el pago antes de eliminarla.");
    db.prepare("DELETE FROM citas WHERE id = ?").run(Number(m[1]));
    return [200, { ok: true }];
  }],

  // ----- pagos -----
  ["POST", /^\/api\/citas\/(\d+)\/pago$/, "escribir", async (req, u, url, m) => {
    const id = Number(m[1]);
    const b = await leerCuerpo(req);
    const c = db.prepare("SELECT * FROM citas WHERE id = ?").get(id);
    if (!c) fallo(404, "La cita ya no existe.");
    if (pagoActivo(id)) fallo(409, "Esta cita ya tiene un pago registrado.");
    if (!c.valor) fallo(400, "Elige el examen y su valor antes de cobrar.");
    const fecha = hoyCaja();
    if (cajaCerrada(fecha)) fallo(409, "La caja de hoy ya está cerrada. Un administrador debe reabrirla para registrar pagos.");
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
    const aPagar = c.copago - descuento;
    const medio = aPagar === 0 ? "Sin copago" : txt(b.medio, 20);
    if (!MEDIOS.includes(medio)) fallo(400, "Elige el medio de pago.");
    const folio = txt(b.folio_bono, 40), boleta = txt(b.boleta, 40);
    if (c.prevision === "Fonasa" && c.bonificacion > 0 && !folio) fallo(400, "Ingresa el folio del bono Fonasa.");
    db.prepare(`INSERT INTO pagos (cita_id, fecha, paciente, rut, equipo, codigo, examen, prevision, valor, bonificacion, copago, medio, folio_bono, usuario_id, creado,
      descuento, descuento_motivo, descuento_detalle, examenes, boleta)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, fecha, c.paciente, c.rut, c.equipo, c.codigo, c.examen, c.prevision,
      c.valor, c.bonificacion, aPagar, medio, folio, u.id, ahoraCaja(), descuento, descuento ? motivoDesc : "", detalle, c.examenes || "", boleta);
    if (["agendado", "confirmado"].includes(c.estado)) db.prepare("UPDATE citas SET estado = 'llego' WHERE id = ?").run(id);
    return [201, citaPorId(id)];
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
    return [200, { ok: true }];
  }],

  // ----- caja -----
  ["GET", /^\/api\/caja$/, "sesion", async (req, u, url) => [200, resumenCaja(...rangoCaja(url))]],

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
    return [200, resumenCaja(fecha)];
  }],

  ["POST", /^\/api\/caja\/reabrir$/, "admin", async (req) => {
    const b = await leerCuerpo(req);
    db.prepare("DELETE FROM cierres WHERE fecha = ?").run(txt(b.fecha, 10));
    return [200, resumenCaja(txt(b.fecha, 10))];
  }],

  ["GET", /^\/api\/caja\/csv$/, "sesion", async (req, u, url) => {
    const [desde, hasta] = rangoCaja(url);
    const r = resumenCaja(desde, hasta);
    const esc = (v) => { const t = String(v ?? ""); return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const filas = [["Fecha", "Hora", "Paciente", "RUT", "Equipo", "Código", "Examen", "Previsión", "Valor", "Bonificación", "Descuento", "Motivo descuento", "Pagado", "Medio", "Folio bono", "Boleta", "Cajero", "Estado"]];
    for (const p of r.pagos) filas.push([p.fecha.split("-").reverse().join("-"), p.creado.slice(11, 16), p.paciente, p.rut, p.equipo.toUpperCase(), p.codigo, p.examen, p.prevision,
      p.valor, p.bonificacion, p.descuento, p.descuento_motivo, p.copago, p.medio, p.folio_bono, p.boleta, p.usuario_nombre, p.anulado ? "ANULADO: " + p.motivo_anulacion : "OK"]);
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
    const a = { codigo: m[1], nombre: txt(b.nombre, 200), equipo: txt(b.equipo, 5), fonasa_total: entero(b.fonasa_total),
      fonasa_bonif: entero(b.fonasa_bonif), particular: entero(b.particular), activo: b.activo === false || b.activo === 0 ? 0 : 1 };
    if (!a.nombre) fallo(400, "Escribe el nombre de la prestación.");
    if (!EQUIPOS.includes(a.equipo)) fallo(400, "Elige el equipo.");
    if (a.fonasa_bonif > a.fonasa_total) fallo(400, "La bonificación no puede ser mayor que el valor.");
    db.prepare(`INSERT INTO aranceles (codigo, nombre, equipo, fonasa_total, fonasa_bonif, particular, activo)
      VALUES (@codigo,@nombre,@equipo,@fonasa_total,@fonasa_bonif,@particular,@activo)
      ON CONFLICT(codigo) DO UPDATE SET nombre=@nombre, equipo=@equipo, fonasa_total=@fonasa_total,
      fonasa_bonif=@fonasa_bonif, particular=@particular, activo=@activo`).run(a);
    return [200, { ok: true }];
  }],

  // ----- respaldo: copia completa y consistente de la base de datos -----
  ["GET", /^\/api\/respaldo$/, "admin", async () => {
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
    [200, plainAll(db.prepare("SELECT id, usuario, nombre, rol, activo, creado FROM usuarios ORDER BY nombre").all())]],

  ["POST", /^\/api\/usuarios$/, "admin", async (req) => {
    const b = await leerCuerpo(req);
    const usuario = txt(b.usuario, 40).toLowerCase(), nombre = txt(b.nombre, 80), clave = String(b.clave || ""), rol = txt(b.rol, 20);
    if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) fallo(400, "El usuario debe tener 3 o más letras o números, sin espacios.");
    if (clave.length < 8) fallo(400, "La clave debe tener al menos 8 caracteres.");
    if (!ROLES.includes(rol)) fallo(400, "Elige un rol.");
    if (db.prepare("SELECT 1 FROM usuarios WHERE usuario = ?").get(usuario)) fallo(409, "Ese usuario ya existe.");
    db.prepare("INSERT INTO usuarios (usuario, nombre, clave_hash, rol) VALUES (?,?,?,?)")
      .run(usuario, nombre || usuario, db.hashClave(clave), rol);
    return [201, { ok: true }];
  }],

  ["PUT", /^\/api\/usuarios\/(\d+)$/, "sesion", async (req, u, url, m) => {
    const id = Number(m[1]), esAdmin = u.rol === "admin";
    if (!esAdmin && id !== u.id) fallo(403, "Solo puedes cambiar tu propia clave.");
    const b = await leerCuerpo(req);
    if (b.clave !== undefined) {
      if (String(b.clave).length < 8) fallo(400, "La clave debe tener al menos 8 caracteres.");
      db.prepare("UPDATE usuarios SET clave_hash = ? WHERE id = ?").run(db.hashClave(b.clave), id);
    }
    if (esAdmin && b.rol !== undefined) {
      if (!ROLES.includes(b.rol)) fallo(400, "Rol no válido.");
      if (id === u.id && b.rol !== "admin") fallo(400, "No puedes quitarte el rol de administrador.");
      db.prepare("UPDATE usuarios SET rol = ? WHERE id = ?").run(b.rol, id);
    }
    if (esAdmin && b.activo !== undefined) {
      if (id === u.id) fallo(400, "No puedes desactivar tu propio usuario.");
      db.prepare("UPDATE usuarios SET activo = ? WHERE id = ?").run(b.activo ? 1 : 0, id);
      if (!b.activo) db.prepare("DELETE FROM sesiones WHERE usuario_id = ?").run(id);
    }
    return [200, { ok: true }];
  }],
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
          if (nivel === "escribir" && u.rol === "lectura") fallo(403, "Tu usuario es solo de lectura.");
          if (nivel === "admin" && u.rol !== "admin") fallo(403, "Solo un administrador puede hacer esto.");
        }
        const [status, data, headers] = await manejador(req, u, url, m);
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
    return enviarArchivo(res, decodeURIComponent(p).replace(/^\/+/, ""));
  } catch (e) {
    if (e instanceof ErrorHttp) return enviarJSON(res, e.status, { error: e.message });
    console.error(e);
    return enviarJSON(res, 500, { error: "Ocurrió un error en el servidor." });
  }
});

servidor.listen(PORT, HOST, () => console.log(`Agenda de Imágenes en http://localhost:${PORT}`));
