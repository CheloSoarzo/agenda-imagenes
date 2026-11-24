// Módulo clínico: agendas por médico, ficha clínica, recetas, órdenes, documentos y auditoría.
//
// Reglas (Ley 20.584 y Decreto 41):
//   - Solo los usuarios con rol «médico» (vinculados a un profesional) ven y escriben la ficha.
//   - Un médico ve la ficha de los pacientes que tienen o tuvieron hora en su agenda o que él atendió.
//   - Una atención firmada no se cambia ni se borra: se corrige con una adenda.
//   - Los documentos emitidos no se cambian: se anulan con motivo y se emite otro.
//   - Cada lectura y cada cambio de la ficha queda en la tabla «auditoria».
//
// Variables opcionales: AGENDAS_EQUIPOS (por defecto «tc,rx,eco»; vacío = centro solo médico),
// CENTRO_DIRECCION y CENTRO_TELEFONO (salen en recetas y documentos), PUBLIC_URL (para el enlace de verificación).
const crypto = require("crypto");

const EQUIPOS_BASE = {
  tc: { nombre: "TC", largo: "Tomografía" },
  rx: { nombre: "RX", largo: "Rayos X" },
  eco: { nombre: "ECO", largo: "Ecografía" },
  mx: { nombre: "MX", largo: "Mamografía" },
};
const TIPOS_DOC = {
  receta: "Receta médica",
  orden: "Orden de exámenes",
  certificado: "Certificado médico",
  interconsulta: "Interconsulta",
  indicaciones: "Indicaciones",
};

module.exports = function clinica(db, h) {
  const { ahoraCaja, hoyCaja, fallo, plain, txt, leerCuerpo, ipDe, integ, CENTRO, LOGO, VERSION } = h;
  prepararEsquema();
  const plainAll = (a) => a.map(plain);
  const equiposBase = String(process.env.AGENDAS_EQUIPOS ?? "tc,rx,eco").split(",").map((x) => x.trim().toLowerCase())
    .filter((x, i, a) => EQUIPOS_BASE[x] && a.indexOf(x) === i);
  const DIRECCION = txt(process.env.CENTRO_DIRECCION, 160), TELEFONO = txt(process.env.CENTRO_TELEFONO, 60);
  const normRut = integ.normRut;
  const rutBonito = (r) => { const n = normRut(r); return n.length < 2 ? r : n.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "-" + n.slice(-1); };
  const fechaCL = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "");
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const SQL_RUT = "UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ',''))";

  // ---------- agendas ----------
  const esConsulta = (id) => /^m\d+$/.test(String(id || ""));
  const profDeAgenda = (id) => (esConsulta(id) ? db.prepare("SELECT * FROM profesionales WHERE id = ?").get(Number(String(id).slice(1))) : null);
  function esAgenda(id, soloActivas = false) {
    if (equiposBase.includes(id)) return true;
    const p = profDeAgenda(id);
    return !!p && (!soloActivas || !!p.activo);
  }
  // Para aranceles: los equipos de imágenes y «med» (consultas, sirven para todos los médicos)
  const esGrupoArancel = (eq) => equiposBase.includes(eq) || eq === "med" || EQUIPOS_BASE[eq];
  function agendas() {
    const lista = equiposBase.map((id) => ({ id, ...EQUIPOS_BASE[id], tipo: "equipo", duracion: 15 }));
    for (const p of db.prepare("SELECT * FROM profesionales WHERE activo = 1 ORDER BY nombre").all())
      lista.push({ id: "m" + p.id, nombre: p.nombre, largo: p.especialidad || "Consulta", tipo: "medico", duracion: p.duracion, profesional_id: p.id });
    return lista;
  }
  // Agendas de un médico (las de los profesionales vinculados a su usuario)
  const agendasDeMedico = (usuarioId) => db.prepare("SELECT id FROM profesionales WHERE usuario_id = ? AND activo = 1").all(usuarioId).map((p) => "m" + p.id);

  // ---------- acceso a la ficha ----------
  function exigirMedico(u) {
    if (u.rol !== "medico") fallo(403, "Solo los médicos pueden ver la ficha clínica.");
    const p = db.prepare("SELECT * FROM profesionales WHERE usuario_id = ? AND activo = 1 ORDER BY id LIMIT 1").get(u.id);
    if (!p) fallo(403, "Tu usuario no está vinculado a un profesional. Pide al administrador que lo vincule.");
    return plain(p);
  }
  function exigirPaciente(prof, rut) {
    if (normRut(rut).length < 7) fallo(400, "El RUT no es válido.");
    const n = normRut(rut);
    const ids = db.prepare("SELECT id FROM profesionales WHERE usuario_id = (SELECT usuario_id FROM profesionales WHERE id = ?)").all(prof.id).map((p) => "m" + p.id);
    const tieneHora = db.prepare(`SELECT 1 FROM citas WHERE ${SQL_RUT} = ? AND equipo IN (${ids.map(() => "?").join(",")}) LIMIT 1`).get(n, ...ids);
    const loAtendio = db.prepare("SELECT 1 FROM atenciones WHERE rut = ? AND profesional_id = ? LIMIT 1").get(n, prof.id);
    if (!tieneHora && !loAtendio) fallo(403, "Este paciente no tiene horas en tu agenda. Solo puedes abrir la ficha de tus pacientes.");
    return n;
  }
  const regAud = db.prepare("INSERT INTO auditoria (fecha, usuario_id, usuario, accion, rut, detalle, ip) VALUES (?,?,?,?,?,?,?)");
  const auditar = (req, u, accion, rut, detalle = "") => regAud.run(ahoraCaja(), u.id, u.usuario, accion, rut || "", String(detalle).slice(0, 300), ipDe(req) || "");

  // Datos del paciente desde su última cita
  function datosPaciente(rut) {
    // Cada dato se toma de la cita más reciente que lo tenga escrito
    const c = {};
    for (const f of db.prepare(`SELECT paciente, fecha_nac, telefono, email, prevision FROM citas WHERE ${SQL_RUT} = ?
      ORDER BY fecha DESC, id DESC LIMIT 50`).all(rut)) for (const [k, v] of Object.entries(f)) if (v && !c[k]) c[k] = v;
    const a = db.prepare("SELECT paciente FROM atenciones WHERE rut = ? ORDER BY id DESC LIMIT 1").get(rut);
    return { rut, rut_txt: rutBonito(rut), paciente: c?.paciente || a?.paciente || "", fecha_nac: c?.fecha_nac || "", telefono: c?.telefono || "",
      email: c?.email || "", prevision: c?.prevision || "" };
  }
  function edad(nac, hoy = hoyCaja()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nac || "")) return "";
    let a = Number(hoy.slice(0, 4)) - Number(nac.slice(0, 4));
    if (hoy.slice(5) < nac.slice(5)) a--;
    return a >= 0 ? a + (a === 1 ? " año" : " años") : "";
  }

  const ANTEC = ["alergias", "morbidos", "quirurgicos", "farmacos", "familiares", "habitos", "gineco"];
  const SIGNOS = ["pa", "fc", "fr", "temp", "sat", "peso", "talla", "hgt"];
  const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
  const atencionDe = (id) => {
    const a = plain(db.prepare(`SELECT a.*, p.nombre AS profesional, p.especialidad, p.titulo FROM atenciones a
      JOIN profesionales p ON p.id = a.profesional_id WHERE a.id = ?`).get(id));
    if (!a) return null;
    a.signos = json(a.signos, {}); a.diagnosticos = json(a.diagnosticos, []);
    a.adendas = plainAll(db.prepare(`SELECT d.*, p.nombre AS profesional, p.titulo FROM adendas d JOIN profesionales p ON p.id = d.profesional_id
      WHERE d.atencion_id = ? ORDER BY d.id`).all(id));
    return a;
  };
  const docDe = (id) => {
    const d = plain(db.prepare(`SELECT d.*, p.nombre AS profesional, p.titulo, p.especialidad, p.rut AS prof_rut, p.registro FROM documentos d
      JOIN profesionales p ON p.id = d.profesional_id WHERE d.id = ?`).get(id));
    if (d) d.contenido = json(d.contenido, {});
    return d;
  };

  function validarContenido(tipo, b) {
    const t = (v, n) => txt(v, n);
    if (tipo === "receta") {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 20).map((i) => ({
        medicamento: t(i?.medicamento, 200), dosis: t(i?.dosis, 80), via: t(i?.via, 40), frecuencia: t(i?.frecuencia, 80),
        duracion: t(i?.duracion, 80), cantidad: t(i?.cantidad, 60), indicaciones: t(i?.indicaciones, 400),
      })).filter((i) => i.medicamento);
      if (!items.length) fallo(400, "Agrega al menos un medicamento.");
      return { items, notas: t(b.notas, 1000) };
    }
    if (tipo === "orden") {
      const area = ["imagenes", "laboratorio", "otro"].includes(b.area) ? b.area : "otro";
      const examenes = (Array.isArray(b.examenes) ? b.examenes : []).map((x) => t(x, 200)).filter(Boolean).slice(0, 40);
      if (!examenes.length) fallo(400, "Agrega al menos un examen.");
      return { area, examenes, diagnostico: t(b.diagnostico, 300), indicaciones: t(b.indicaciones, 1000) };
    }
    if (tipo === "interconsulta") {
      const c = { especialidad: t(b.especialidad, 120), motivo: t(b.motivo, 2000), antecedentes: t(b.antecedentes, 3000) };
      if (!c.especialidad || !c.motivo) fallo(400, "Escribe la especialidad y el motivo de la interconsulta.");
      return c;
    }
    const c = { texto: t(b.texto, 5000) };
    if (!c.texto) fallo(400, "Escribe el texto del documento.");
    return c;
  }
  const codigoNuevo = () => {
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (;;) {
      const c = Array.from(crypto.randomBytes(10), (x) => abc[x % abc.length]).join("");
      if (!db.prepare("SELECT 1 FROM documentos WHERE codigo = ?").get(c)) return c.slice(0, 5) + "-" + c.slice(5);
    }
  };
  const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`).replace(/\/+$/, "");

  // ---------- documento imprimible ----------
  function htmlDocumento(d, req, { publico = false } = {}) {
    const pac = datosPaciente(d.rut);
    const c = d.contenido;
    let cuerpo = "";
    if (d.tipo === "receta") {
      cuerpo = `<ol class="rx">${c.items.map((i) => `<li><b>${esc(i.medicamento)}</b>${i.dosis ? " · " + esc(i.dosis) : ""}${i.via ? " · vía " + esc(i.via) : ""}
        <div>${[i.frecuencia, i.duracion && "por " + i.duracion, i.cantidad && "cantidad: " + i.cantidad].filter(Boolean).map(esc).join(" · ")}</div>
        ${i.indicaciones ? `<div class="ind">${esc(i.indicaciones)}</div>` : ""}</li>`).join("")}</ol>
        ${c.notas ? `<p class="nota">${esc(c.notas)}</p>` : ""}`;
    } else if (d.tipo === "orden") {
      const area = { imagenes: "Imagenología", laboratorio: "Laboratorio", otro: "Exámenes" }[c.area];
      cuerpo = `<p class="sub">${area}</p><ul class="ex">${c.examenes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        ${c.diagnostico ? `<p><b>Diagnóstico o sospecha:</b> ${esc(c.diagnostico)}</p>` : ""}
        ${c.indicaciones ? `<p><b>Indicaciones:</b> ${esc(c.indicaciones)}</p>` : ""}`;
    } else if (d.tipo === "interconsulta") {
      cuerpo = `<p><b>Se deriva a:</b> ${esc(c.especialidad)}</p><p><b>Motivo:</b></p><p class="txt">${esc(c.motivo)}</p>
        ${c.antecedentes ? `<p><b>Antecedentes relevantes:</b></p><p class="txt">${esc(c.antecedentes)}</p>` : ""}`;
    } else {
      cuerpo = `<p class="txt">${esc(c.texto)}</p>`;
    }
    const url = `${baseUrl(req)}/verificar/${d.codigo}`;
    const titulo = TIPOS_DOC[d.tipo] || "Documento";
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} · ${esc(pac.paciente)}</title>
<style>
@page{size:letter;margin:16mm 16mm 14mm}
*{box-sizing:border-box} body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1a1a1a;margin:0;background:#f2f2f2}
.hoja{max-width:800px;margin:24px auto;background:#fff;padding:36px 44px;box-shadow:0 2px 12px rgba(0,0,0,.08);min-height:900px;display:flex;flex-direction:column}
.cab{display:flex;gap:16px;align-items:center;border-bottom:2px solid #222;padding-bottom:12px}
.cab img{max-height:56px;max-width:160px}.cab .c{flex:1}.cab b{font-size:17px}.cab .m{color:#555;font-size:12.5px}
h1{font-size:19px;margin:20px 0 4px;letter-spacing:.3px}
.anulado{color:#b00020;border:2px solid #b00020;display:inline-block;padding:4px 10px;font-weight:700;margin:6px 0}
.pac{display:grid;grid-template-columns:1fr 1fr;gap:2px 24px;margin:10px 0 16px;padding:10px 12px;background:#f6f6f6;border-radius:6px;font-size:13.5px}
.rx{padding-left:22px}.rx li{margin:0 0 12px}.rx .ind,.nota{color:#444;font-style:italic}
.ex li{margin:0 0 4px}.sub{font-weight:600;margin:0 0 4px}.txt{white-space:pre-wrap}
.firma{margin-top:auto;padding-top:40px;display:flex;justify-content:space-between;align-items:flex-end;gap:20px}
.firma .f{text-align:center;min-width:260px;border-top:1px solid #333;padding-top:6px;font-size:13px}
.ver{font-size:11.5px;color:#555;text-align:right}.ver b{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#111}
.pie{font-size:11px;color:#777;text-align:center;margin-top:18px;border-top:1px solid #ddd;padding-top:8px}
.acc{max-width:800px;margin:16px auto 0;display:flex;gap:8px;justify-content:flex-end}
.acc button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #bbb;background:#fff;cursor:pointer}.acc .p{background:#1f4fd1;color:#fff;border-color:#1f4fd1}
@media print{body{background:#fff}.hoja{box-shadow:none;margin:0;padding:0;max-width:none;min-height:calc(100vh - 2px)}.acc{display:none}}
</style></head><body>
${publico ? "" : `<div class="acc"><button onclick="window.close()">Cerrar</button><button class="p" onclick="window.print()">Imprimir</button></div>`}
<div class="hoja">
  <div class="cab">${LOGO ? `<img src="${esc(LOGO)}" alt="">` : ""}<div class="c"><b>${esc(CENTRO || "Centro médico")}</b>
    <div class="m">${[DIRECCION, TELEFONO].filter(Boolean).map(esc).join(" · ")}</div></div></div>
  <h1>${esc(titulo.toUpperCase())}</h1>
  ${d.anulado ? `<div class="anulado">DOCUMENTO ANULADO el ${esc(fechaCL(d.anulado_en))}: ${esc(d.anulado_motivo)}</div>` : ""}
  <div class="pac">
    <div><b>Paciente:</b> ${esc(pac.paciente)}</div><div><b>RUT:</b> ${esc(pac.rut_txt)}</div>
    <div><b>Edad:</b> ${esc(edad(pac.fecha_nac, d.creado.slice(0, 10)) || "—")}</div><div><b>Fecha:</b> ${esc(fechaCL(d.creado))}</div>
  </div>
  ${cuerpo}
  <div class="firma">
    <div class="ver">Verifique este documento en<br>${esc(url.replace(/\/verificar\/.*/, "/verificar"))}<br>código <b>${esc(d.codigo)}</b></div>
    <div class="f"><b>${esc(d.titulo)} ${esc(d.profesional)}</b><br>${esc(d.especialidad || "")}${d.prof_rut ? "<br>RUT " + esc(rutBonito(d.prof_rut)) : ""}${d.registro ? " · Reg. SIS " + esc(d.registro) : ""}
      <br><span style="color:#666;font-size:11.5px">Firmado electrónicamente el ${esc(fechaCL(d.creado))} ${esc(d.creado.slice(11, 16))}</span></div>
  </div>
  <div class="pie">${esc(String(baseUrl(req)).replace(/^https?:\/\//, ""))} · Versión ${esc(VERSION)} · © 2026 MSC26</div>
</div></body></html>`;
  }

  // ---------- rutas ----------
  // ================== HORARIOS DE ATENCIÓN Y BLOQUEOS ==================
  // Cada médico puede tener bloques semanales (día 1 = lunes … 7 = domingo) y bloqueos por fecha
  // (vacaciones, congresos, una tarde libre). Un médico SIN bloques semanales no tiene restricción de horario.
  const DIAS = ["", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"];
  const DIA1 = ["", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
  const reHH = /^([01]\d|2[0-3]):[0-5]\d$/;
  const reF = /^\d{4}-\d{2}-\d{2}$/;
  const min = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  const fCL = (f) => f.split("-").reverse().join("/");
  const diaSemana = (f) => { const d = new Date(f + "T12:00:00Z").getUTCDay(); return d === 0 ? 7 : d; };
  const bloquesDe = (pid) => db.prepare("SELECT dia, desde, hasta FROM horarios WHERE profesional_id = ? ORDER BY dia, desde").all(pid).map(plain);
  const bloqueosDe = (pid, desde, hasta) => db.prepare(
    "SELECT * FROM bloqueos WHERE profesional_id = ? AND hasta_fecha >= ? AND desde_fecha <= ? ORDER BY desde_fecha, hora_desde").all(pid, desde, hasta).map(plain);
  const nombreProf = (pid) => { const p = db.prepare("SELECT nombre, titulo FROM profesionales WHERE id = ?").get(pid); return p ? `${p.titulo} ${p.nombre}`.trim() : "El profesional"; };

  // ¿La cita cae dentro del horario del médico? Devuelve "" si está bien, o el motivo si no.
  function fueraDeHorario(c) {
    if (!esConsulta(c.equipo)) return "";
    const pid = Number(c.equipo.slice(1));
    const ini = min(c.hora), fin = ini + (Number(c.duracion) || 15);
    for (const b of bloqueosDe(pid, c.fecha, c.fecha)) {
      if (!b.hora_desde || (ini < min(b.hora_hasta) && fin > min(b.hora_desde)))
        return `${nombreProf(pid)} no atiende ${b.hora_desde ? `de ${b.hora_desde} a ${b.hora_hasta} ` : ""}el ${fCL(c.fecha)}${b.motivo ? ` (${b.motivo})` : ""}.`;
    }
    const bloques = bloquesDe(pid);
    if (!bloques.length) return "";
    const dia = diaSemana(c.fecha), hoyB = bloques.filter((b) => b.dia === dia);
    if (!hoyB.length) return `${nombreProf(pid)} no atiende los ${DIAS[dia]}.`;
    if (hoyB.some((b) => ini >= min(b.desde) && fin <= min(b.hasta))) return "";
    return `${nombreProf(pid)} atiende los ${DIAS[dia]} ${hoyB.map((b) => `${b.desde}–${b.hasta}`).join(" y ")}: las ${c.hora} (${fin - ini} min) quedan fuera de su horario.`;
  }
  // Al guardar una cita: se revisa si es nueva o si cambió día, hora, duración o agenda.
  // Fuera de horario se rechaza (código 428) salvo que recepción o el administrador confirmen el sobrecupo.
  function revisarHorario(c, cuerpo, previo) {
    // Devuelve 1 si la cita queda como sobrecupo, 0 si no
    if (!esConsulta(c.equipo)) return 0;
    if (previo && previo.fecha === c.fecha && previo.hora === c.hora && Number(previo.duracion) === Number(c.duracion) && previo.equipo === c.equipo)
      return Number(previo.sobrecupo) ? 1 : 0;
    const motivo = fueraDeHorario(c);
    if (motivo && !cuerpo.sobrecupo) fallo(428, motivo);
    return motivo ? 1 : 0;
  }
  function validarHorario(b) {
    const bloques = (Array.isArray(b.bloques) ? b.bloques : []).slice(0, 50).map((x) => ({ dia: Math.round(Number(x.dia)), desde: txt(x.desde, 5), hasta: txt(x.hasta, 5) }));
    for (const x of bloques) {
      if (!(x.dia >= 1 && x.dia <= 7) || !reHH.test(x.desde) || !reHH.test(x.hasta)) fallo(400, "Revisa los horarios: cada bloque necesita día, hora de inicio y hora de término.");
      if (min(x.hasta) <= min(x.desde)) fallo(400, `El bloque del ${DIA1[x.dia]} ${x.desde}–${x.hasta} termina antes de empezar.`);
    }
    for (let d = 1; d <= 7; d++) {
      const del = bloques.filter((x) => x.dia === d).sort((a, z) => min(a.desde) - min(z.desde));
      for (let i = 1; i < del.length; i++) if (min(del[i].desde) < min(del[i - 1].hasta)) fallo(400, `Los bloques del ${DIA1[d]} se topan (${del[i - 1].desde}–${del[i - 1].hasta} y ${del[i].desde}–${del[i].hasta}).`);
    }
    return bloques;
  }
  // Citas ya agendadas (desde hoy) que quedan fuera del horario o en un bloqueo de este médico
  const citasFuera = (pid) => db.prepare(`SELECT id, fecha, hora, duracion, equipo, paciente, sobrecupo FROM citas
    WHERE equipo = ? AND fecha >= ? AND estado NOT IN ('cancelado','atendido','ausente') ORDER BY fecha, hora LIMIT 500`).all("m" + pid, hoyCaja())
    .map(plain).filter((c) => !c.sobrecupo && fueraDeHorario(c)).map((c) => ({ id: c.id, fecha: c.fecha, hora: c.hora, paciente: c.paciente, motivo: fueraDeHorario(c) }));
  const existeProf = (pid) => { if (!db.prepare("SELECT 1 FROM profesionales WHERE id = ?").get(pid)) fallo(404, "El profesional no existe."); };

  const rutas = [
    // ----- horarios de atención (los ve todo el que tenga sesión; los cambia solo el administrador) -----
    ["GET", /^\/api\/clinica\/horarios$/, "sesion", async (req, u, url) => {
      const desde = url.searchParams.get("desde") || hoyCaja(), hasta = url.searchParams.get("hasta") || desde;
      if (!reF.test(desde) || !reF.test(hasta)) fallo(400, "Fechas no válidas.");
      const r = {};
      for (const p of db.prepare("SELECT id FROM profesionales WHERE activo = 1").all())
        r["m" + p.id] = { bloques: bloquesDe(p.id), bloqueos: bloqueosDe(p.id, desde, hasta) };
      return [200, r];
    }],
    ["GET", /^\/api\/profesionales\/(\d+)\/horario$/, "admin", async (req, u, url, m) => {
      const pid = Number(m[1]); existeProf(pid);
      return [200, { bloques: bloquesDe(pid), bloqueos: bloqueosDe(pid, hoyCaja(), "9999-12-31"), fuera: citasFuera(pid) }];
    }],
    ["PUT", /^\/api\/profesionales\/(\d+)\/horario$/, "admin", async (req, u, url, m) => {
      const pid = Number(m[1]); existeProf(pid);
      const bloques = validarHorario(await leerCuerpo(req));
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM horarios WHERE profesional_id = ?").run(pid);
        const ins = db.prepare("INSERT INTO horarios (profesional_id, dia, desde, hasta) VALUES (?,?,?,?)");
        for (const x of bloques) ins.run(pid, x.dia, x.desde, x.hasta);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      return [200, { bloques: bloquesDe(pid), bloqueos: bloqueosDe(pid, hoyCaja(), "9999-12-31"), fuera: citasFuera(pid) }];
    }],
    ["POST", /^\/api\/profesionales\/(\d+)\/bloqueos$/, "admin", async (req, u, url, m) => {
      const pid = Number(m[1]); existeProf(pid);
      const b = await leerCuerpo(req);
      const x = { desde: txt(b.desde_fecha, 10), hasta: txt(b.hasta_fecha, 10) || txt(b.desde_fecha, 10), hd: txt(b.hora_desde, 5), hh: txt(b.hora_hasta, 5), motivo: txt(b.motivo, 120) };
      if (!reF.test(x.desde) || !reF.test(x.hasta)) fallo(400, "Indica desde y hasta qué fecha no atiende.");
      if (x.hasta < x.desde) fallo(400, "La fecha de término es anterior a la de inicio.");
      if ((x.hd || x.hh) && (!reHH.test(x.hd) || !reHH.test(x.hh) || min(x.hh) <= min(x.hd))) fallo(400, "Revisa el rango de horas del bloqueo (o déjalo vacío para el día completo).");
      db.prepare("INSERT INTO bloqueos (profesional_id, desde_fecha, hasta_fecha, hora_desde, hora_hasta, motivo, creado_por, creado) VALUES (?,?,?,?,?,?,?,?)")
        .run(pid, x.desde, x.hasta, x.hd, x.hh, x.motivo, u.id, ahoraCaja());
      return [201, { bloques: bloquesDe(pid), bloqueos: bloqueosDe(pid, hoyCaja(), "9999-12-31"), fuera: citasFuera(pid) }];
    }],
    ["DELETE", /^\/api\/bloqueos\/(\d+)$/, "admin", async (req, u, url, m) => {
      const b = db.prepare("SELECT profesional_id FROM bloqueos WHERE id = ?").get(Number(m[1]));
      if (!b) fallo(404, "El bloqueo ya no existe.");
      db.prepare("DELETE FROM bloqueos WHERE id = ?").run(Number(m[1]));
      const pid = b.profesional_id;
      return [200, { bloques: bloquesDe(pid), bloqueos: bloqueosDe(pid, hoyCaja(), "9999-12-31"), fuera: citasFuera(pid) }];
    }],


    ["GET", /^\/api\/agendas$/, "sesion", async () => [200, agendas()]],

    // ----- profesionales (administración) -----
    ["GET", /^\/api\/profesionales$/, "admin", async () =>
      [200, plainAll(db.prepare(`SELECT p.*, u.usuario, u.nombre AS usuario_nombre FROM profesionales p
        LEFT JOIN usuarios u ON u.id = p.usuario_id ORDER BY p.activo DESC, p.nombre`).all())]],

    ["POST", /^\/api\/profesionales$/, "admin", async (req) => guardarProf(null, await leerCuerpo(req))],
    ["PUT", /^\/api\/profesionales\/(\d+)$/, "admin", async (req, u, url, m) => guardarProf(Number(m[1]), await leerCuerpo(req))],

    ["GET", /^\/api\/auditoria$/, "admin", async (req, u, url) => {
      const rut = normRut(url.searchParams.get("rut") || "");
      const filas = rut
        ? db.prepare("SELECT * FROM auditoria WHERE rut = ? ORDER BY id DESC LIMIT 500").all(rut)
        : db.prepare("SELECT * FROM auditoria ORDER BY id DESC LIMIT 300").all();
      return [200, plainAll(filas).map((f) => ({ ...f, rut_txt: f.rut ? rutBonito(f.rut) : "" }))];
    }],

    // ----- ficha clínica (solo médicos) -----
    ["GET", /^\/api\/clinica\/yo$/, "sesion", async (req, u) => [200, exigirMedico(u)]],

    // Pacientes del día en la agenda del médico
    ["GET", /^\/api\/clinica\/dia$/, "sesion", async (req, u, url) => {
      const prof = exigirMedico(u);
      const fecha = url.searchParams.get("fecha") || hoyCaja();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) fallo(400, "La fecha no es válida.");
      const ids = agendasDeMedico(u.id);
      const citas = plainAll(db.prepare(`SELECT c.id, c.fecha, c.hora, c.duracion, c.paciente, c.rut, c.estado, c.examen, c.notas, c.prevision, c.fecha_nac,
        (SELECT a.id FROM atenciones a WHERE a.cita_id = c.id ORDER BY a.id DESC LIMIT 1) AS atencion_id,
        (SELECT a.firmada FROM atenciones a WHERE a.cita_id = c.id ORDER BY a.id DESC LIMIT 1) AS firmada
        FROM citas c WHERE c.fecha = ? AND c.equipo IN (${ids.map(() => "?").join(",") || "''"}) AND c.estado != 'cancelado' ORDER BY c.hora`).all(fecha, ...ids));
      return [200, { profesional: prof, fecha, citas: citas.map((c) => ({ ...c, rut_norm: normRut(c.rut), edad: edad(c.fecha_nac) })) }];
    }],

    // Datos mínimos de una cita de la agenda del médico (para abrir la ficha desde la agenda)
    ["GET", /^\/api\/clinica\/cita\/(\d+)$/, "sesion", async (req, u, url, m) => {
      exigirMedico(u);
      const c = db.prepare("SELECT id, fecha, rut, equipo FROM citas WHERE id = ?").get(Number(m[1]));
      if (!c || !agendasDeMedico(u.id).includes(c.equipo)) fallo(404, "Esa cita no es de tu agenda.");
      return [200, { id: c.id, fecha: c.fecha, rut: normRut(c.rut) }];
    }],

    // Ficha completa de un paciente
    ["GET", /^\/api\/clinica\/paciente$/, "sesion", async (req, u, url) => {
      const prof = exigirMedico(u);
      const rut = exigirPaciente(prof, url.searchParams.get("rut"));
      auditar(req, u, "ver_ficha", rut);
      const pac = datosPaciente(rut);
      const antecedentes = plain(db.prepare("SELECT * FROM antecedentes WHERE rut = ?").get(rut)) || { rut };
      const atenciones = db.prepare("SELECT id FROM atenciones WHERE rut = ? ORDER BY fecha DESC, id DESC").all(rut).map((a) => atencionDe(a.id))
        .filter((a) => a.firmada || a.profesional_id === prof.id); // los borradores solo los ve su autor
      const documentos = plainAll(db.prepare(`SELECT d.id, d.tipo, d.atencion_id, d.creado, d.codigo, d.anulado, d.anulado_motivo, d.contenido,
        p.nombre AS profesional, p.titulo, d.profesional_id FROM documentos d JOIN profesionales p ON p.id = d.profesional_id WHERE d.rut = ? ORDER BY d.id DESC`).all(rut))
        .map((d) => ({ ...d, contenido: json(d.contenido, {}), tipo_txt: TIPOS_DOC[d.tipo] }));
      // Exámenes de imágenes de este centro (agendas de equipos) con su avance en el PACS
      const examenes = plainAll(db.prepare(`SELECT id, fecha, hora, equipo, examen, estado, accesion, pacs_estado, medico FROM citas
        WHERE ${SQL_RUT} = ? AND equipo NOT LIKE 'm%' ORDER BY fecha DESC, hora DESC LIMIT 200`).all(rut));
      const consultas = plainAll(db.prepare(`SELECT c.id, c.fecha, c.hora, c.equipo, c.estado, p.nombre AS profesional FROM citas c
        LEFT JOIN profesionales p ON 'm' || p.id = c.equipo WHERE ${SQL_RUT.replace(/rut/g, "c.rut")} = ? AND c.equipo LIKE 'm%' ORDER BY c.fecha DESC, c.hora DESC LIMIT 200`).all(rut));
      return [200, { profesional: prof, paciente: { ...pac, edad: edad(pac.fecha_nac) }, antecedentes, atenciones, documentos, examenes, consultas,
        pacs_publico: integ.pacsPublico || "" }];
    }],

    ["PUT", /^\/api\/clinica\/antecedentes$/, "sesion", async (req, u) => {
      const prof = exigirMedico(u);
      const b = await leerCuerpo(req);
      const rut = exigirPaciente(prof, b.rut);
      const ant = db.prepare("SELECT * FROM antecedentes WHERE rut = ?").get(rut);
      const nuevo = Object.fromEntries(ANTEC.map((k) => [k, txt(b[k], 3000)]));
      if (ant && ANTEC.every((k) => ant[k] === nuevo[k])) return [200, plain(ant)];
      if (ant) db.prepare("INSERT INTO antecedentes_historial (rut, datos, usuario_id, creado) VALUES (?,?,?,?)").run(rut, JSON.stringify(plain(ant)), u.id, ahoraCaja());
      db.prepare(`INSERT INTO antecedentes (rut, ${ANTEC.join(",")}, actualizado, actualizado_por) VALUES (@rut, ${ANTEC.map((k) => "@" + k).join(",")}, @fecha, @uid)
        ON CONFLICT(rut) DO UPDATE SET ${ANTEC.map((k) => `${k}=@${k}`).join(",")}, actualizado=@fecha, actualizado_por=@uid`)
        .run({ ...nuevo, rut, fecha: ahoraCaja(), uid: u.id });
      auditar(req, u, "antecedentes", rut);
      return [200, plain(db.prepare("SELECT * FROM antecedentes WHERE rut = ?").get(rut))];
    }],

    // Nueva atención (borrador). Si la cita ya tiene un borrador del mismo médico, se devuelve ese.
    ["POST", /^\/api\/clinica\/atenciones$/, "sesion", async (req, u) => {
      const prof = exigirMedico(u);
      const b = await leerCuerpo(req);
      const rut = exigirPaciente(prof, b.rut);
      const citaId = Math.round(Number(b.cita_id)) || null;
      if (citaId) {
        const c = db.prepare("SELECT rut FROM citas WHERE id = ?").get(citaId);
        if (!c || normRut(c.rut) !== rut) fallo(400, "La cita no corresponde a este paciente.");
        const prev = db.prepare("SELECT id FROM atenciones WHERE cita_id = ? AND profesional_id = ? AND firmada = 0").get(citaId, prof.id);
        if (prev) return [200, atencionDe(prev.id)];
      }
      const ahora = ahoraCaja();
      const r = db.prepare(`INSERT INTO atenciones (rut, paciente, cita_id, profesional_id, fecha, creado, actualizado) VALUES (?,?,?,?,?,?,?)`)
        .run(rut, datosPaciente(rut).paciente, citaId, prof.id, ahora, ahora, ahora);
      auditar(req, u, "nueva_atencion", rut, "atención " + r.lastInsertRowid);
      if (citaId) db.prepare("UPDATE citas SET estado = 'atendido', actualizado_por = ?, actualizado = datetime('now') WHERE id = ? AND estado IN ('agendado','confirmado','llego')").run(u.id, citaId);
      // Si el paciente sacó número en el tótem, su turno queda atendido
      if (citaId) try { db.prepare("UPDATE turnos SET estado = 'atendido', cerrado_en = ? WHERE cita_id = ? AND estado IN ('espera','llamado')").run(ahora, citaId); } catch {}
      return [201, atencionDe(Number(r.lastInsertRowid))];
    }],

    ["PUT", /^\/api\/clinica\/atenciones\/(\d+)$/, "sesion", async (req, u, url, m) => {
      const prof = exigirMedico(u);
      const a = db.prepare("SELECT * FROM atenciones WHERE id = ?").get(Number(m[1]));
      if (!a) fallo(404, "La atención no existe.");
      if (a.profesional_id !== prof.id) fallo(403, "Solo quien creó la atención puede escribirla.");
      if (a.firmada) fallo(409, "La atención ya está firmada. Para corregirla agrega una adenda.");
      const b = await leerCuerpo(req);
      const signos = Object.fromEntries(SIGNOS.map((k) => [k, txt(b.signos?.[k], 20)]).filter(([, v]) => v));
      const diagnosticos = (Array.isArray(b.diagnosticos) ? b.diagnosticos : []).slice(0, 15)
        .map((d) => ({ codigo: txt(d?.codigo, 10).toUpperCase(), nombre: txt(d?.nombre, 200) })).filter((d) => d.nombre || d.codigo);
      db.prepare(`UPDATE atenciones SET motivo=?, anamnesis=?, examen_fisico=?, signos=?, diagnosticos=?, plan=?, actualizado=? WHERE id=?`)
        .run(txt(b.motivo, 500), txt(b.anamnesis, 10000), txt(b.examen_fisico, 6000), JSON.stringify(signos), JSON.stringify(diagnosticos),
          txt(b.plan, 6000), ahoraCaja(), a.id);
      return [200, atencionDe(a.id)];
    }],

    ["DELETE", /^\/api\/clinica\/atenciones\/(\d+)$/, "sesion", async (req, u, url, m) => {
      const prof = exigirMedico(u);
      const a = db.prepare("SELECT * FROM atenciones WHERE id = ?").get(Number(m[1]));
      if (!a) fallo(404, "La atención no existe.");
      if (a.profesional_id !== prof.id || a.firmada) fallo(409, "Solo se puede descartar un borrador propio sin firmar.");
      if (db.prepare("SELECT 1 FROM documentos WHERE atencion_id = ?").get(a.id)) fallo(409, "Esta atención ya tiene documentos emitidos: fírmala en vez de descartarla.");
      db.prepare("DELETE FROM atenciones WHERE id = ?").run(a.id);
      auditar(req, u, "descartar_borrador", a.rut, "atención " + a.id);
      return [200, { ok: true }];
    }],

    ["POST", /^\/api\/clinica\/atenciones\/(\d+)\/firmar$/, "sesion", async (req, u, url, m) => {
      const prof = exigirMedico(u);
      const a = db.prepare("SELECT * FROM atenciones WHERE id = ?").get(Number(m[1]));
      if (!a) fallo(404, "La atención no existe.");
      if (a.profesional_id !== prof.id) fallo(403, "Solo quien creó la atención puede firmarla.");
      if (a.firmada) return [200, atencionDe(a.id)];
      if (!a.motivo && !a.anamnesis && !a.plan) fallo(400, "La atención está vacía: escribe al menos el motivo, la anamnesis o el plan.");
      db.prepare("UPDATE atenciones SET firmada = 1, firmada_en = ?, actualizado = ? WHERE id = ?").run(ahoraCaja(), ahoraCaja(), a.id);
      auditar(req, u, "firmar_atencion", a.rut, "atención " + a.id);
      return [200, atencionDe(a.id)];
    }],

    ["POST", /^\/api\/clinica\/atenciones\/(\d+)\/adenda$/, "sesion", async (req, u, url, m) => {
      const prof = exigirMedico(u);
      const a = db.prepare("SELECT * FROM atenciones WHERE id = ?").get(Number(m[1]));
      if (!a) fallo(404, "La atención no existe.");
      exigirPaciente(prof, a.rut);
      if (!a.firmada) fallo(409, "La atención aún no está firmada: edítala directamente.");
      const texto = txt((await leerCuerpo(req)).texto, 4000);
      if (!texto) fallo(400, "Escribe el texto de la adenda.");
      db.prepare("INSERT INTO adendas (atencion_id, profesional_id, texto, creado) VALUES (?,?,?,?)").run(a.id, prof.id, texto, ahoraCaja());
      auditar(req, u, "adenda", a.rut, "atención " + a.id);
      return [201, atencionDe(a.id)];
    }],

    // ----- documentos -----
    ["POST", /^\/api\/clinica\/documentos$/, "sesion", async (req, u) => {
      const prof = exigirMedico(u);
      const b = await leerCuerpo(req);
      if (!TIPOS_DOC[b.tipo]) fallo(400, "Tipo de documento no válido.");
      const rut = exigirPaciente(prof, b.rut);
      let atencionId = Math.round(Number(b.atencion_id)) || null;
      if (atencionId) {
        const a = db.prepare("SELECT rut FROM atenciones WHERE id = ?").get(atencionId);
        if (!a || a.rut !== rut) fallo(400, "La atención no corresponde a este paciente.");
      }
      const contenido = validarContenido(b.tipo, b.contenido || {});
      const r = db.prepare(`INSERT INTO documentos (tipo, rut, paciente, atencion_id, profesional_id, contenido, codigo, creado) VALUES (?,?,?,?,?,?,?,?)`)
        .run(b.tipo, rut, datosPaciente(rut).paciente, atencionId, prof.id, JSON.stringify(contenido), codigoNuevo(), ahoraCaja());
      auditar(req, u, "emitir_" + b.tipo, rut, "documento " + r.lastInsertRowid);
      return [201, docDe(Number(r.lastInsertRowid))];
    }],

    ["POST", /^\/api\/clinica\/documentos\/(\d+)\/anular$/, "sesion", async (req, u, url, m) => {
      const prof = exigirMedico(u);
      const d = db.prepare("SELECT * FROM documentos WHERE id = ?").get(Number(m[1]));
      if (!d) fallo(404, "El documento no existe.");
      if (d.profesional_id !== prof.id) fallo(403, "Solo quien emitió el documento puede anularlo.");
      if (d.anulado) fallo(409, "El documento ya está anulado.");
      const motivo = txt((await leerCuerpo(req)).motivo, 300);
      if (!motivo) fallo(400, "Escribe el motivo de la anulación.");
      db.prepare("UPDATE documentos SET anulado = 1, anulado_motivo = ?, anulado_en = ? WHERE id = ?").run(motivo, ahoraCaja(), d.id);
      auditar(req, u, "anular_documento", d.rut, "documento " + d.id + ": " + motivo);
      return [200, docDe(d.id)];
    }],

    ["GET", /^\/api\/clinica\/documentos\/(\d+)\/imprimir$/, "sesion", async (req, u, url, m) => {
      const prof = exigirMedico(u);
      const d = docDe(Number(m[1]));
      if (!d) fallo(404, "El documento no existe.");
      exigirPaciente(prof, d.rut);
      auditar(req, u, "imprimir_documento", d.rut, "documento " + d.id);
      return ["RAW", htmlDocumento(d, req), { "Content-Type": "text/html; charset=utf-8" }];
    }],

    // Sugerencias a partir de lo ya escrito en el centro (diagnósticos y medicamentos usados antes)
    ["GET", /^\/api\/clinica\/sugerencias$/, "sesion", async (req, u, url) => {
      exigirMedico(u);
      const tipo = url.searchParams.get("tipo"), q = txt(url.searchParams.get("q"), 60).toLowerCase();
      const conteo = new Map();
      if (tipo === "diagnostico") {
        for (const r of db.prepare("SELECT diagnosticos FROM atenciones WHERE diagnosticos != '' ORDER BY id DESC LIMIT 3000").all())
          for (const d of json(r.diagnosticos, [])) { const k = JSON.stringify([d.codigo || "", d.nombre || ""]); conteo.set(k, (conteo.get(k) || 0) + 1); }
      } else if (tipo === "medicamento") {
        for (const r of db.prepare("SELECT contenido FROM documentos WHERE tipo = 'receta' ORDER BY id DESC LIMIT 3000").all())
          for (const i of json(r.contenido, {}).items || []) {
            const k = JSON.stringify([i.medicamento, i.dosis || "", i.via || "", i.frecuencia || "", i.duracion || ""]); conteo.set(k, (conteo.get(k) || 0) + 1); }
      } else if (tipo === "examen") {
        for (const r of db.prepare("SELECT contenido FROM documentos WHERE tipo = 'orden' ORDER BY id DESC LIMIT 3000").all())
          for (const x of json(r.contenido, {}).examenes || []) { const k = JSON.stringify([x]); conteo.set(k, (conteo.get(k) || 0) + 1); }
        for (const a of db.prepare("SELECT nombre FROM aranceles WHERE activo = 1 AND equipo != 'med'").all()) { const k = JSON.stringify([a.nombre]); conteo.set(k, (conteo.get(k) || 0) + 1); }
      } else fallo(400, "Tipo no válido.");
      const lista = [...conteo].map(([k, n]) => ({ v: JSON.parse(k), n }))
        .filter((x) => !q || x.v.join(" ").toLowerCase().includes(q)).sort((a, b) => b.n - a.n).slice(0, 12);
      return [200, lista.map((x) => x.v)];
    }],
  ];

  function guardarProf(id, b) {
    const p = {
      nombre: txt(b.nombre, 120), rut: normRut(b.rut || ""), especialidad: txt(b.especialidad, 120), registro: txt(b.registro, 40),
      titulo: txt(b.titulo, 10) || "Dr.", duracion: Math.round(Number(b.duracion)) || 20, activo: b.activo === false || b.activo === 0 ? 0 : 1,
      usuario_id: Math.round(Number(b.usuario_id)) || null,
    };
    if (!p.nombre) fallo(400, "Escribe el nombre del profesional.");
    if (p.rut && !integ.rutValido(p.rut)) fallo(400, "El RUT del profesional no es válido.");
    if (p.duracion < 5 || p.duracion > 240) fallo(400, "La duración de la consulta debe estar entre 5 y 240 minutos.");
    if (p.usuario_id) {
      const us = db.prepare("SELECT * FROM usuarios WHERE id = ? AND eliminado = 0").get(p.usuario_id);
      if (!us) fallo(400, "El usuario elegido no existe.");
      if (us.rol === "admin") fallo(400, "Vincula un usuario propio del médico, no uno de administrador.");
      const otro = db.prepare("SELECT nombre FROM profesionales WHERE usuario_id = ? AND id != ?").get(p.usuario_id, id || 0);
      if (otro) fallo(409, `Ese usuario ya está vinculado a ${otro.nombre}.`);
      // El usuario pasa a ser médico y ve solo su agenda
      db.prepare("UPDATE usuarios SET rol = 'medico' WHERE id = ?").run(p.usuario_id);
    }
    if (id) {
      const r = db.prepare(`UPDATE profesionales SET nombre=@nombre, rut=@rut, especialidad=@especialidad, registro=@registro, titulo=@titulo,
        duracion=@duracion, activo=@activo, usuario_id=@usuario_id WHERE id=@id`).run({ ...p, id });
      if (!r.changes) fallo(404, "El profesional no existe.");
      return [200, { ok: true, id }];
    }
    const r = db.prepare(`INSERT INTO profesionales (nombre, rut, especialidad, registro, titulo, duracion, activo, usuario_id)
      VALUES (@nombre,@rut,@especialidad,@registro,@titulo,@duracion,@activo,@usuario_id)`).run(p);
    return [201, { ok: true, id: Number(r.lastInsertRowid) }];
  }

  // Página pública de verificación (la abre la farmacia o quien recibe el documento)
  function paginaVerificar(req, codigo) {
    const d = db.prepare("SELECT id FROM documentos WHERE codigo = ?").get(String(codigo || "").toUpperCase().slice(0, 20));
    if (!d) return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verificar documento</title>
      <body style="font:16px system-ui;max-width:520px;margin:60px auto;padding:0 20px"><h2>Documento no encontrado</h2>
      <p>Revisa el código. Si está bien escrito, este documento no fue emitido por ${esc(CENTRO || "este centro")}.</p>
      <form method="get" action="/verificar"><input name="c" placeholder="XXXXX-XXXXX" style="font:inherit;padding:8px" autocomplete="off"> <button style="font:inherit;padding:8px 14px">Verificar</button></form></body>`;
    return htmlDocumento(docDe(d.id), req, { publico: true });
  }


  // ---------- esquema (solo cuando el módulo clínico está encendido: MODULO_CLINICO=1) ----------
  // Antes de cambiar la estructura de la base se guarda una copia completa en la carpeta de datos.
  function prepararEsquema() {
    const yaTiene = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'profesionales'").get();
    if (!yaTiene) {
      const path = require("path");
      const copia = path.join(db.dataDir || ".", `agenda-antes-modulo-clinico-${hoyCaja()}.db`);
      try { require("fs").rmSync(copia, { force: true }); db.exec(`VACUUM INTO '${copia.replace(/'/g, "''")}'`);
        console.log(`Módulo clínico: copia de la base antes de activarlo en ${copia}`); }
      catch (e) { console.error("Módulo clínico: no se pudo guardar la copia previa, no se activa:", e.message); throw e; }
    }
    // ================== MÓDULO CLÍNICO (centro médico) ==================
    // Las agendas dejan de ser fijas (TC, RX, ECO): cada médico tiene su agenda «m<id>».
    // Se quitan las restricciones CHECK que fijaban equipos y roles. Es un cambio solo del esquema,
    // sin perder datos: cada tabla se reconstruye igual pero sin esa restricción (funciona también en Node 26).
    {
      const quitar = [
        ["usuarios", / CHECK \(rol IN \([^)]*\)\)/],
        ["citas", / CHECK \(equipo IN \([^)]*\)\)/],
        ["aranceles", / CHECK \(equipo IN \([^)]*\)\)/],
      ];
      const cambios = [];
      for (const [tabla, re] of quitar) {
        const fila = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabla);
        if (fila && re.test(fila.sql)) cambios.push([tabla, fila.sql.replace(re, "")]);
      }
      if (cambios.length) {
        // Se reconstruye cada tabla sin la restricción (método oficial de SQLite para cambiar una tabla):
        // tabla nueva → copiar los datos → borrar la antigua → renombrar → recrear índices. Todo en una transacción.
        db.exec("PRAGMA foreign_keys = OFF");
        db.exec("PRAGMA legacy_alter_table = ON");
        db.exec("BEGIN");
        try {
          for (const [tabla, sql] of cambios) {
            const extras = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(tabla).map((r) => r.sql);
            const temporal = `${tabla}_sin_check`;
            db.exec(`DROP TABLE IF EXISTS "${temporal}"`);
            db.exec(sql.replace(/^CREATE TABLE\s+("?)(\w+)\1/i, `CREATE TABLE "${temporal}"`));
            const cols = db.prepare(`PRAGMA table_info("${tabla}")`).all().map((c) => `"${c.name}"`).join(", ");
            db.exec(`INSERT INTO "${temporal}" (${cols}) SELECT ${cols} FROM "${tabla}"`);
            db.exec(`DROP TABLE "${tabla}"`);
            db.exec(`ALTER TABLE "${temporal}" RENAME TO "${tabla}"`);
            for (const x of extras) db.exec(x);
          }
          const malas = db.prepare("PRAGMA foreign_key_check").all();
          if (malas.length) throw new Error("Referencias rotas: " + JSON.stringify(malas.slice(0, 3)));
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        } finally {
          db.exec("PRAGMA legacy_alter_table = OFF");
          db.exec("PRAGMA foreign_keys = ON");
        }
        const ok = db.prepare("PRAGMA integrity_check").get().integrity_check;
        console.log(`Esquema actualizado para agendas de médicos (${cambios.map((c) => c[0]).join(", ")}): ${ok}`);
      }
    }

    db.exec(`
    -- Profesionales que atienden (su agenda es «m<id>»)
    CREATE TABLE IF NOT EXISTS profesionales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      rut TEXT NOT NULL DEFAULT '',
      especialidad TEXT NOT NULL DEFAULT '',
      registro TEXT NOT NULL DEFAULT '',          -- N° registro Superintendencia de Salud
      titulo TEXT NOT NULL DEFAULT 'Dr.',         -- Dr. / Dra. / otro
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      duracion INTEGER NOT NULL DEFAULT 20,       -- minutos por consulta
      activo INTEGER NOT NULL DEFAULT 1,
      creado TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Antecedentes del paciente (uno por RUT). Cada cambio queda en antecedentes_historial.
    CREATE TABLE IF NOT EXISTS antecedentes (
      rut TEXT PRIMARY KEY,                       -- RUT normalizado (sin puntos ni guion)
      alergias TEXT NOT NULL DEFAULT '',
      morbidos TEXT NOT NULL DEFAULT '',
      quirurgicos TEXT NOT NULL DEFAULT '',
      farmacos TEXT NOT NULL DEFAULT '',
      familiares TEXT NOT NULL DEFAULT '',
      habitos TEXT NOT NULL DEFAULT '',
      gineco TEXT NOT NULL DEFAULT '',
      actualizado TEXT NOT NULL DEFAULT '',
      actualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS antecedentes_historial (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rut TEXT NOT NULL,
      datos TEXT NOT NULL,                        -- JSON con los antecedentes anteriores
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      creado TEXT NOT NULL
    );

    -- Atención médica (evolución). Una vez firmada no se puede cambiar: se corrige con una adenda.
    CREATE TABLE IF NOT EXISTS atenciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rut TEXT NOT NULL,                          -- RUT normalizado
      paciente TEXT NOT NULL DEFAULT '',
      cita_id INTEGER REFERENCES citas(id) ON DELETE SET NULL,
      profesional_id INTEGER NOT NULL REFERENCES profesionales(id),
      fecha TEXT NOT NULL,                        -- fecha y hora de la atención (hora de Chile)
      motivo TEXT NOT NULL DEFAULT '',
      anamnesis TEXT NOT NULL DEFAULT '',
      examen_fisico TEXT NOT NULL DEFAULT '',
      signos TEXT NOT NULL DEFAULT '',            -- JSON: pa, fc, fr, temp, sat, peso, talla
      diagnosticos TEXT NOT NULL DEFAULT '',      -- JSON: [{codigo, nombre}]
      plan TEXT NOT NULL DEFAULT '',
      firmada INTEGER NOT NULL DEFAULT 0,
      firmada_en TEXT NOT NULL DEFAULT '',
      creado TEXT NOT NULL,
      actualizado TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_atenciones_rut ON atenciones(rut);
    CREATE INDEX IF NOT EXISTS idx_atenciones_cita ON atenciones(cita_id);
    CREATE TABLE IF NOT EXISTS adendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      atencion_id INTEGER NOT NULL REFERENCES atenciones(id),
      profesional_id INTEGER NOT NULL REFERENCES profesionales(id),
      texto TEXT NOT NULL,
      creado TEXT NOT NULL
    );

    -- Documentos emitidos: receta, orden de exámenes, certificado, interconsulta, indicaciones.
    -- No se modifican: si hay un error se anulan (con motivo) y se emite otro.
    CREATE TABLE IF NOT EXISTS documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      rut TEXT NOT NULL,
      paciente TEXT NOT NULL DEFAULT '',
      atencion_id INTEGER REFERENCES atenciones(id),
      profesional_id INTEGER NOT NULL REFERENCES profesionales(id),
      contenido TEXT NOT NULL,                    -- JSON según el tipo
      codigo TEXT NOT NULL UNIQUE,                -- código de verificación
      creado TEXT NOT NULL,
      anulado INTEGER NOT NULL DEFAULT 0,
      anulado_motivo TEXT NOT NULL DEFAULT '',
      anulado_en TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_documentos_rut ON documentos(rut);

    -- Auditoría de la ficha clínica: quién vio o cambió qué, cuándo y desde dónde (Ley 20.584)
    CREATE TABLE IF NOT EXISTS auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT NOT NULL,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      usuario TEXT NOT NULL DEFAULT '',
      accion TEXT NOT NULL,
      rut TEXT NOT NULL DEFAULT '',
      detalle TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_auditoria_rut ON auditoria(rut);
    CREATE INDEX IF NOT EXISTS idx_auditoria_fecha ON auditoria(fecha);

    -- Horario semanal de cada médico (día 1 = lunes … 7 = domingo). Sin filas = sin restricción.
    CREATE TABLE IF NOT EXISTS horarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profesional_id INTEGER NOT NULL REFERENCES profesionales(id) ON DELETE CASCADE,
      dia INTEGER NOT NULL,
      desde TEXT NOT NULL,                        -- HH:MM
      hasta TEXT NOT NULL                         -- HH:MM
    );
    CREATE INDEX IF NOT EXISTS idx_horarios_prof ON horarios(profesional_id);
    -- Días u horas en que el médico no atiende (vacaciones, congresos…). Sin horas = día completo.
    CREATE TABLE IF NOT EXISTS bloqueos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profesional_id INTEGER NOT NULL REFERENCES profesionales(id) ON DELETE CASCADE,
      desde_fecha TEXT NOT NULL,
      hasta_fecha TEXT NOT NULL,
      hora_desde TEXT NOT NULL DEFAULT '',
      hora_hasta TEXT NOT NULL DEFAULT '',
      motivo TEXT NOT NULL DEFAULT '',
      creado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      creado TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bloqueos_prof ON bloqueos(profesional_id, desde_fecha);
    `);
    // Citas dadas fuera del horario del médico con confirmación (sobrecupo)
    if (!db.prepare("PRAGMA table_info(citas)").all().some((c) => c.name === "sobrecupo"))
      db.exec("ALTER TABLE citas ADD COLUMN sobrecupo INTEGER NOT NULL DEFAULT 0");
  }

  return { activo: true, rutas, agendas, esAgenda, esConsulta, esGrupoArancel, agendasDeMedico, paginaVerificar, revisarHorario, fueraDeHorario, equiposBase };
};
