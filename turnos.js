// Turnos: tótem de llegada, pantalla de llamado y llamado desde recepción o desde la ficha del médico.
//
// Modo mixto:
//   - «Tengo hora»: el paciente marca su RUT; si tiene cita hoy, recibe un número C (con hora), la cita pasa a
//     «En espera» y queda unida al turno. Si no tiene cita hoy, recibe igual un número A y recepción ve el aviso.
//   - «No tengo hora / otros trámites»: número A directo, sin pedir datos.
// Los números se reinician cada día. El tótem y la pantalla no usan usuario: entran con la clave de dispositivo
// que el administrador genera en Turnos → Configuración (solo sirve para sacar números y ver los llamados).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

module.exports = function turnos(db, h) {
  const { ahoraCaja, hoyCaja, fallo, plain, txt, leerCuerpo, integ, clin, CENTRO, LOGO } = h;
  const plainAll = (a) => a.map(plain);
  const normRut = integ.normRut;
  const SQL_RUT = "UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ',''))";

  db.exec(`
  CREATE TABLE IF NOT EXISTS turnos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,                    -- día (los números se reinician cada día)
    letra TEXT NOT NULL,                    -- C = con hora, A = sin hora / otros trámites
    numero INTEGER NOT NULL,
    rut TEXT NOT NULL DEFAULT '',
    cita_id INTEGER REFERENCES citas(id) ON DELETE SET NULL,
    agenda TEXT NOT NULL DEFAULT '',        -- agenda de la cita (m<id> o equipo)
    nombre_corto TEXT NOT NULL DEFAULT '',  -- «Pedro M.» para la pantalla
    sin_cita INTEGER NOT NULL DEFAULT 0,    -- marcó RUT pero no tenía hora hoy
    estado TEXT NOT NULL DEFAULT 'espera',  -- espera | llamado | atendido | ausente
    puesto TEXT NOT NULL DEFAULT '',        -- «Mesón 1», «Dr. Mora · Box 3»
    llamadas INTEGER NOT NULL DEFAULT 0,
    llamado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    creado TEXT NOT NULL,
    llamado_en TEXT NOT NULL DEFAULT '',
    cerrado_en TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_turnos_fecha ON turnos(fecha);
  CREATE INDEX IF NOT EXISTS idx_turnos_cita ON turnos(cita_id);
  `);
  // Etapa del turno: «meson» (recepción: admisión y pago) → «box» (pasó a la sala y espera al médico)
  if (!db.prepare("PRAGMA table_info(turnos)").all().some((c) => c.name === "etapa"))
    db.exec("ALTER TABLE turnos ADD COLUMN etapa TEXT NOT NULL DEFAULT 'meson'");
  if (!db.prepare("PRAGMA table_info(turnos)").all().some((c) => c.name === "creado_box"))
    db.exec("ALTER TABLE turnos ADD COLUMN creado_box TEXT NOT NULL DEFAULT ''");

  // ---------- configuración (en la tabla meta) ----------
  const getMeta = (k, d = "") => (db.prepare("SELECT valor FROM meta WHERE clave = ?").get(k) || {}).valor ?? d;
  const setMeta = (k, v) => db.prepare("INSERT INTO meta (clave, valor) VALUES (?,?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(k, String(v));
  const config = () => ({
    mostrar_nombre: getMeta("turnos_nombre", "1") === "1",
    imprimir: getMeta("turnos_imprimir", "0") === "1",
    voz: getMeta("turnos_voz", "1") === "1",
    clave: getMeta("turnos_clave", ""),
    videos: getMeta("turnos_videos", "1") === "1",
    video_sonido: getMeta("turnos_video_sonido", "0") === "1",
  });

  // ---------- videos de la pantalla de llamado (DATA_DIR/videos) ----------
  // Se suben desde Turnos → Configuración y se reproducen en bucle en la mitad izquierda del televisor.
  const VIDEOS = path.join(db.dataDir, "videos");
  const VIDEO_MAX = (Number(process.env.VIDEOS_MAX_MB) || 500) * 1024 * 1024;
  const NOMBRE_VIDEO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(mp4|webm|m4v)$/i;
  const TIPO_VIDEO = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm" };
  const limpiarNombre = (n) => {
    const base = path.basename(String(n || "")).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "");
    const ext = path.extname(base).toLowerCase();
    const r = base.slice(0, base.length - ext.length).slice(0, 70) + ext;
    return NOMBRE_VIDEO.test(r) ? r : "";
  };
  const listaVideos = () => {
    let a = [];
    try { a = fs.readdirSync(VIDEOS).filter((f) => NOMBRE_VIDEO.test(f)); } catch {}
    return a.sort((x, y) => x.localeCompare(y, "es")).map((f) => ({ nombre: f, mb: Math.round(fs.statSync(path.join(VIDEOS, f)).size / 1048576 * 10) / 10 }));
  };
  // Entrega un video con soporte de «Range» (los televisores y navegadores lo piden por partes)
  function servirVideo(req, res, url) {
    try { exigirClave(url.searchParams.get("k") || ""); } catch { res.writeHead(403); return res.end(); }
    let nombre = "";
    try { nombre = decodeURIComponent(url.pathname.slice("/videos/".length)); } catch {}
    if (!NOMBRE_VIDEO.test(nombre)) { res.writeHead(404); return res.end(); }
    const ruta = path.join(VIDEOS, nombre);
    fs.stat(ruta, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
      const tipo = TIPO_VIDEO[path.extname(nombre).toLowerCase()] || "application/octet-stream";
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      let ini = 0, fin = st.size - 1, status = 200;
      if (m && (m[1] || m[2])) {
        if (m[1]) { ini = Number(m[1]); if (m[2]) fin = Math.min(Number(m[2]), st.size - 1); }
        else { ini = Math.max(0, st.size - Number(m[2])); }
        if (ini > fin || ini >= st.size) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
        status = 206;
      }
      const cab = { "Content-Type": tipo, "Accept-Ranges": "bytes", "Content-Length": fin - ini + 1, "Cache-Control": "private, max-age=3600" };
      if (status === 206) cab["Content-Range"] = `bytes ${ini}-${fin}/${st.size}`;
      res.writeHead(status, cab);
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(ruta, { start: ini, end: fin }).on("error", () => res.destroy()).pipe(res);
    });
  }
  const exigirClave = (k) => {
    const c = config().clave;
    if (!c || !k || k.length !== c.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(c)))
      fallo(403, "Este dispositivo no está autorizado. Pide al administrador la dirección del tótem.");
  };

  const corto = (nombre) => {
    const p = String(nombre || "").trim().split(/\s+/).filter(Boolean);
    return p.length ? p[0] + (p[1] ? " " + p[1][0].toUpperCase() + "." : "") : "";
  };
  const codigo = (t) => `${t.letra}-${String(t.numero).padStart(3, "0")}`;
  const agendaTxt = (id) => {
    if (clin.esConsulta(id)) {
      const p = db.prepare("SELECT nombre, titulo FROM profesionales WHERE id = ?").get(Number(id.slice(1)));
      return p ? `${p.titulo} ${p.nombre}`.trim() : "";
    }
    return ({ tc: "Tomografía", rx: "Rayos X", eco: "Ecografía", mx: "Mamografía" })[id] || "";
  };
  const minutos = (desde, hasta = ahoraCaja()) => Math.max(0, Math.round((Date.parse(hasta.replace(" ", "T")) - Date.parse(desde.replace(" ", "T"))) / 60000));
  const vista = (t) => ({ ...plain(t), codigo: codigo(t), agenda_txt: agendaTxt(t.agenda),
    espera_min: t.etapa === "box" && t.estado === "espera" ? minutos(t.creado_box || t.creado) : minutos(t.creado, t.llamado_en || undefined) });

  function nuevoTurno({ letra, rut = "", cita = null, sinCita = 0, nombre = "" }) {
    const fecha = hoyCaja();
    const n = (db.prepare("SELECT MAX(numero) AS n FROM turnos WHERE fecha = ? AND letra = ?").get(fecha, letra).n || 0) + 1;
    const r = db.prepare(`INSERT INTO turnos (fecha, letra, numero, rut, cita_id, agenda, nombre_corto, sin_cita, creado) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(fecha, letra, n, rut, cita ? cita.id : null, cita ? cita.equipo : "", corto(nombre || cita?.paciente), sinCita, ahoraCaja());
    return db.prepare("SELECT * FROM turnos WHERE id = ?").get(Number(r.lastInsertRowid));
  }

  // Lo que ve la pantalla de llamado: el último llamado grande y los anteriores
  function estadoPantalla() {
    const cfg = config();
    const filas = db.prepare(`SELECT * FROM turnos WHERE fecha = ? AND llamado_en != '' ORDER BY llamado_en DESC, id DESC LIMIT 7`).all(hoyCaja());
    const fuera = (t) => ({ id: t.id, codigo: codigo(t), nombre: cfg.mostrar_nombre ? t.nombre_corto : "", puesto: t.puesto,
      llamadas: t.llamadas, llamado_en: t.llamado_en, clave_sonido: `${t.id}:${t.llamadas}` });
    const espera = db.prepare("SELECT COUNT(*) AS n FROM turnos WHERE fecha = ? AND estado = 'espera'").get(hoyCaja()).n;
    // El llamado se muestra en grande solo durante 60 segundos; después pasa a «Llamados anteriores»
    const seg = (x) => (Date.parse(ahoraCaja().replace(" ", "T") + "Z") - Date.parse(x.replace(" ", "T") + "Z")) / 1000;
    const vigente = filas[0] && seg(filas[0].llamado_en) < 60
      && !(filas[0].estado === "atendido" && filas[0].cerrado_en);
    const actual = vigente ? filas[0] : null;
    return { centro: CENTRO, logo: LOGO, actual: actual ? fuera(actual) : null, anteriores: (actual ? filas.slice(1) : filas.slice(0, 6)).map(fuera),
      en_espera: espera, voz: cfg.voz,
      videos: cfg.videos ? listaVideos().map((v) => v.nombre) : [], video_sonido: cfg.video_sonido };
  }

  function llamar(u, t, puesto) {
    if (!t) fallo(404, "No hay pacientes esperando.");
    if (["atendido", "ausente"].includes(t.estado)) fallo(409, "Ese turno ya está cerrado.");
    db.prepare("UPDATE turnos SET estado = 'llamado', puesto = ?, llamadas = llamadas + 1, llamado_por = ?, llamado_en = ? WHERE id = ?")
      .run(puesto, u.id, ahoraCaja(), t.id);
    return vista(db.prepare("SELECT * FROM turnos WHERE id = ?").get(t.id));
  }

  // Médico: sus agendas activas
  const agendasMedico = (u) => clin.agendasDeMedico(u.id);

  const rutas = [
    // ----- tótem y pantalla (clave de dispositivo, sin usuario) -----
    ["GET", /^\/api\/turnos\/publico$/, "libre", async (req, u, url) => {
      exigirClave(url.searchParams.get("k"));
      const cfg = config();
      return [200, { centro: CENTRO, logo: LOGO, imprimir: cfg.imprimir }];
    }],

    ["POST", /^\/api\/turnos\/totem$/, "libre", async (req) => {
      const b = await leerCuerpo(req);
      exigirClave(String(b.k || ""));
      if (b.tipo === "general") {
        const t = nuevoTurno({ letra: "A" });
        return [201, { codigo: codigo(t), mensaje: "Espere su llamado en la pantalla.", fecha: t.creado }];
      }
      const rut = normRut(b.rut || "");
      if (rut.length < 7 || !integ.rutValido(rut)) fallo(400, "El RUT no es válido. Revíselo e intente de nuevo.");
      // Si ya sacó número hoy y sigue esperando, se le muestra el mismo
      const previo = db.prepare("SELECT * FROM turnos WHERE fecha = ? AND rut = ? AND estado IN ('espera','llamado') ORDER BY id DESC LIMIT 1").get(hoyCaja(), rut);
      if (previo) return [200, { codigo: codigo(previo), repetido: true, mensaje: "Usted ya tiene número. Espere su llamado en la pantalla.", fecha: previo.creado }];
      const citas = db.prepare(`SELECT * FROM citas WHERE fecha = ? AND ${SQL_RUT} = ? AND estado NOT IN ('cancelado','atendido','ausente') ORDER BY hora`).all(hoyCaja(), rut);
      if (!citas.length) {
        const t = nuevoTurno({ letra: "A", rut, sinCita: 1 });
        return [201, { codigo: codigo(t), sin_cita: true, mensaje: "No encontramos una hora para hoy con su RUT. Recepción lo atenderá.", fecha: t.creado }];
      }
      // La primera cita del día que aún no se atiende; las demás quedan en «En espera» también
      const c = citas[0];
      for (const x of citas) if (["agendado", "confirmado"].includes(x.estado))
        db.prepare("UPDATE citas SET estado = 'llego', actualizado = datetime('now') WHERE id = ?").run(x.id);
      for (const x of citas) integ.avisar(x.id);
      const t = nuevoTurno({ letra: "C", rut, cita: c });
      const saludo = corto(c.paciente).split(" ")[0];
      const cuando = citas.map((x) => `${x.hora} ${agendaTxt(x.equipo)}`.trim()).join(" · ");
      return [201, { codigo: codigo(t), nombre: saludo, mensaje: `Su hora: ${cuando}. Espere su llamado en la pantalla.`, fecha: t.creado }];
    }],

    ["GET", /^\/api\/turnos\/pantalla$/, "libre", async (req, u, url) => {
      exigirClave(url.searchParams.get("k"));
      return [200, estadoPantalla()];
    }],

    // ----- personal del centro -----
    ["GET", /^\/api\/turnos$/, "sesion", async (req, u) => {
      const filas = db.prepare(`SELECT t.*, c.hora AS cita_hora, c.paciente AS cita_paciente, c.estado AS cita_estado FROM turnos t
        LEFT JOIN citas c ON c.id = t.cita_id WHERE t.fecha = ? ORDER BY t.id`).all(hoyCaja());
      let lista = filas.map((t) => ({ ...vista(t), cita_hora: t.cita_hora || "", paciente: t.cita_paciente || "", cita_estado: t.cita_estado || "" }));
      if (u.rol === "medico") { const ag = agendasMedico(u); lista = lista.filter((t) => ag.includes(t.agenda)); }
      const hechos = lista.filter((t) => t.llamado_en);
      const prom = hechos.length ? Math.round(hechos.reduce((s, t) => s + minutos(t.creado, t.llamado_en), 0) / hechos.length) : 0;
      return [200, { hoy: hoyCaja(), turnos: lista, espera_promedio: prom, config: u.rol === "admin" ? config() : undefined }];
    }],

    // Llamar al siguiente (o a un turno puntual con id). Recepción llama la fila general; el médico, a sus pacientes.
    ["POST", /^\/api\/turnos\/llamar$/, "sesion", async (req, u) => {
      if (u.rol === "lectura") fallo(403, "Tu usuario es solo de lectura.");
      const b = await leerCuerpo(req);
      const puesto = txt(b.puesto, 40);
      if (!puesto) fallo(400, "Escribe tu mesón o box (por ejemplo «Mesón 1»).");
      let t;
      if (b.id) {
        t = db.prepare("SELECT * FROM turnos WHERE id = ? AND fecha = ?").get(Math.round(Number(b.id)), hoyCaja());
        if (t && u.rol === "medico" && !agendasMedico(u).includes(t.agenda)) fallo(403, "Ese paciente no es de tu agenda.");
      } else if (u.rol === "medico") {
        const ag = agendasMedico(u);
        // El médico llama a su siguiente paciente: el de cita más temprana que ya llegó
        t = db.prepare(`SELECT t.* FROM turnos t JOIN citas c ON c.id = t.cita_id WHERE t.fecha = ? AND t.estado = 'espera'
          AND t.agenda IN (${ag.map(() => "?").join(",") || "''"}) ORDER BY (t.etapa = 'box') DESC, c.hora, t.id LIMIT 1`).get(hoyCaja(), ...ag);
      } else {
        // Recepción: el turno más antiguo; con «solo» = 'A' o 'C' se limita a una fila
        const solo = ["A", "C"].includes(b.solo) ? b.solo : "";
        t = db.prepare(`SELECT * FROM turnos WHERE fecha = ? AND estado = 'espera' AND etapa = 'meson'${solo ? " AND letra = ?" : ""} ORDER BY id LIMIT 1`)
          .get(...[hoyCaja(), ...(solo ? [solo] : [])]);
      }
      return [200, llamar(u, t, puesto)];
    }],

    ["POST", /^\/api\/turnos\/(\d+)\/(atendido|ausente|espera)$/, "sesion", async (req, u, url, m) => {
      if (u.rol === "lectura") fallo(403, "Tu usuario es solo de lectura.");
      const t = db.prepare("SELECT * FROM turnos WHERE id = ?").get(Number(m[1]));
      if (!t) fallo(404, "El turno no existe.");
      if (u.rol === "medico" && !agendasMedico(u).includes(t.agenda)) fallo(403, "Ese paciente no es de tu agenda.");
      const estado = m[2];
      // Recepción termina con un paciente que tiene hora con un médico: no se cierra, pasa a la sala a esperar al médico
      if (estado === "atendido" && u.rol !== "medico" && t.etapa === "meson" && clin.esConsulta(t.agenda)) {
        db.prepare("UPDATE turnos SET estado = 'espera', etapa = 'box', puesto = '', creado_box = ? WHERE id = ?").run(ahoraCaja(), t.id);
        return [200, { ...vista(db.prepare("SELECT * FROM turnos WHERE id = ?").get(t.id)), a_sala: true }];
      }
      db.prepare("UPDATE turnos SET estado = ?, cerrado_en = ? WHERE id = ?").run(estado, estado === "espera" ? "" : ahoraCaja(), t.id);
      // No se presentó al llamado: si tenía cita y nadie la ha atendido, vuelve a «En espera» en la agenda solo si se reactiva
      return [200, vista(db.prepare("SELECT * FROM turnos WHERE id = ?").get(t.id))];
    }],

    // Recepción entrega un número a mano (por ejemplo, a quien no quiere usar el tótem)
    ["POST", /^\/api\/turnos\/manual$/, "escribir", async (req) => {
      const b = await leerCuerpo(req);
      let cita = null;
      if (b.cita_id) {
        cita = db.prepare("SELECT * FROM citas WHERE id = ?").get(Math.round(Number(b.cita_id)));
        if (!cita) fallo(404, "La cita ya no existe.");
        if (["agendado", "confirmado"].includes(cita.estado)) db.prepare("UPDATE citas SET estado = 'llego' WHERE id = ?").run(cita.id);
      }
      const t = nuevoTurno({ letra: cita ? "C" : "A", rut: cita ? normRut(cita.rut) : "", cita, nombre: txt(b.nombre, 80) });
      return [201, vista(t)];
    }],

    // ----- configuración (administrador) -----
    ["PUT", /^\/api\/turnos\/config$/, "admin", async (req) => {
      const b = await leerCuerpo(req);
      if (b.mostrar_nombre !== undefined) setMeta("turnos_nombre", b.mostrar_nombre ? "1" : "0");
      if (b.imprimir !== undefined) setMeta("turnos_imprimir", b.imprimir ? "1" : "0");
      if (b.voz !== undefined) setMeta("turnos_voz", b.voz ? "1" : "0");
      if (b.videos !== undefined) setMeta("turnos_videos", b.videos ? "1" : "0");
      if (b.video_sonido !== undefined) setMeta("turnos_video_sonido", b.video_sonido ? "1" : "0");
      if (b.nueva_clave) setMeta("turnos_clave", crypto.randomBytes(12).toString("base64url"));
      return [200, config()];
    }],

    // ----- videos de la pantalla (administrador) -----
    ["GET", /^\/api\/turnos\/videos$/, "admin", async () => [200, { videos: listaVideos(), max_mb: VIDEO_MAX / 1048576 }]],
    // Subida: el cuerpo es el archivo tal cual (?nombre=archivo.mp4)
    ["POST", /^\/api\/turnos\/videos$/, "admin", async (req, u, url) => {
      const nombre = limpiarNombre(url.searchParams.get("nombre"));
      if (!nombre) fallo(400, "El video debe ser un archivo .mp4 o .webm.");
      if (Number(req.headers["content-length"] || 0) > VIDEO_MAX) fallo(413, `El video pesa más de ${VIDEO_MAX / 1048576} MB.`);
      fs.mkdirSync(VIDEOS, { recursive: true });
      const tmp = path.join(VIDEOS, "." + nombre + "." + crypto.randomBytes(4).toString("hex") + ".subiendo");
      let n = 0;
      try {
        await pipeline(req, async function* (src) {
          for await (const c of src) { n += c.length; if (n > VIDEO_MAX) fallo(413, `El video pesa más de ${VIDEO_MAX / 1048576} MB.`); yield c; }
        }, fs.createWriteStream(tmp));
        if (n === 0) fallo(400, "El archivo llegó vacío.");
        fs.renameSync(tmp, path.join(VIDEOS, nombre));
      } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      return [201, { videos: listaVideos() }];
    }],
    ["DELETE", /^\/api\/turnos\/videos\/([^/]+)$/, "admin", async (req, u, url, m) => {
      let nombre = ""; try { nombre = decodeURIComponent(m[1]); } catch {}
      if (!NOMBRE_VIDEO.test(nombre)) fallo(404, "Video no encontrado.");
      try { fs.unlinkSync(path.join(VIDEOS, nombre)); } catch { fallo(404, "Video no encontrado."); }
      return [200, { videos: listaVideos() }];
    }],

    // Estadísticas de un período
    ["GET", /^\/api\/turnos\/estadisticas$/, "admin", async (req, u, url) => {
      const desde = url.searchParams.get("desde") || hoyCaja(), hasta = url.searchParams.get("hasta") || desde;
      const filas = db.prepare("SELECT * FROM turnos WHERE fecha BETWEEN ? AND ?").all(desde, hasta);
      const llam = filas.filter((t) => t.llamado_en);
      const porHora = {};
      for (const t of filas) { const hh = t.creado.slice(11, 13); porHora[hh] = (porHora[hh] || 0) + 1; }
      const porPuesto = {};
      for (const t of llam) porPuesto[t.puesto] = (porPuesto[t.puesto] || 0) + 1;
      return [200, { desde, hasta, total: filas.length, con_hora: filas.filter((t) => t.letra === "C").length, sin_hora: filas.filter((t) => t.letra === "A").length,
        ausentes: filas.filter((t) => t.estado === "ausente").length,
        espera_promedio: llam.length ? Math.round(llam.reduce((s, t) => s + minutos(t.creado, t.llamado_en), 0) / llam.length) : 0,
        espera_maxima: llam.reduce((m, t) => Math.max(m, minutos(t.creado, t.llamado_en)), 0), por_hora: porHora, por_puesto: porPuesto }];
    }],
  ];

  // Turno de hoy de una cita (para la ficha del médico y la agenda)
  const turnoDeCita = (citaId) => {
    const t = db.prepare("SELECT * FROM turnos WHERE cita_id = ? AND fecha = ? ORDER BY id DESC LIMIT 1").get(citaId, hoyCaja());
    return t ? { id: t.id, codigo: codigo(t), estado: t.estado, espera_min: minutos(t.creado, t.llamado_en || undefined) } : null;
  };

  return { rutas, turnoDeCita, config, servirVideo };
};
