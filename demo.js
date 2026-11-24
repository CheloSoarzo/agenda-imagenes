// Datos de ejemplo para la DEMO (DEMO_DATOS=true). Solo se cargan si la base no tiene profesionales.
// Pacientes y médicos ficticios; las citas quedan en torno al día de hoy para que la demo siempre tenga movimiento.
module.exports = function cargarDemo(db, { ahoraCaja, hoyCaja }) {
  if (db.prepare("SELECT COUNT(*) AS n FROM profesionales").get().n > 0) return;
  const clave = process.env.ADMIN_CLAVE || "demo12345";
  const hoy = hoyCaja();
  const dia = (n) => { const d = new Date(hoy + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  db.exec("BEGIN");
  try {
    const usr = db.prepare("INSERT INTO usuarios (usuario, nombre, clave_hash, rol) VALUES (?,?,?,?)");
    const uid = (u, n, r) => Number(usr.run(u, n, db.hashClave(clave), r).lastInsertRowid);
    uid("recepcion", "Recepción Demo", "recepcion");
    const uSoto = uid("drasoto", "Ana Soto Rojas", "medico");
    const uMora = uid("drmora", "Luis Mora Díaz", "medico");
    const prof = db.prepare("INSERT INTO profesionales (nombre, rut, especialidad, registro, titulo, duracion, usuario_id) VALUES (?,?,?,?,?,?,?)");
    const pSoto = Number(prof.run("Ana Soto Rojas", "123456785", "Medicina general", "654321", "Dra.", 20, uSoto).lastInsertRowid);
    const pMora = Number(prof.run("Luis Mora Díaz", "987654325", "Medicina interna", "112233", "Dr.", 30, uMora).lastInsertRowid);

    // Aranceles de consulta (valores de ejemplo, ajustar en Aranceles)
    const ar = db.prepare("INSERT OR IGNORE INTO aranceles (codigo, nombre, equipo, fonasa_total, fonasa_bonif, particular) VALUES (?,?,?,?,?,?)");
    ar.run("DEMO-C1", "CONSULTA MEDICINA GENERAL", "med", 0, 0, 25000);
    ar.run("DEMO-C2", "CONSULTA MEDICINA INTERNA", "med", 0, 0, 35000);

    const pacientes = [
      ["María González Pérez", "11.111.111-1", "1980-05-04", "+56 9 1111 1111"],
      ["Pedro Muñoz Tapia", "22.222.222-2", "1957-11-20", "+56 9 2222 2222"],
      ["Camila Rojas Silva", "15.432.876-9", "1999-02-14", "+56 9 3333 3333"],
      ["Jorge Fuentes Lagos", "19.876.543-0", "1972-08-30", "+56 9 4444 4444"],
      ["Valentina Díaz Soto", "20.345.678-6", "2015-06-09", "+56 9 5555 5555"],
      ["Rosa Contreras Vera", "8.765.432-K", "1948-01-25", "+56 9 6666 6666"],
    ];
    const cita = db.prepare(`INSERT INTO citas (fecha, hora, duracion, equipo, paciente, rut, telefono, fecha_nac, examen, prevision, estado, codigo, valor, copago, creado_por, actualizado_por)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1)`);
    const nueva = (f, h, eq, p, ex, prev, est, cod = "", val = 0) => {
      const [nom, rut, nac, tel] = pacientes[p];
      const dur = eq === "m" + pMora ? 30 : eq === "m" + pSoto ? 20 : 15;
      const id = Number(cita.run(f, h, dur, eq, nom, rut, tel, nac, ex, prev, est, cod, val, val).lastInsertRowid);
      db.prepare("UPDATE citas SET accesion = ? WHERE id = ?").run(db.accesionDe(id), id);
      return id;
    };
    const mS = "m" + pSoto, mM = "m" + pMora;
    // Hoy
    nueva(hoy, "09:00", mS, 0, "CONSULTA MEDICINA GENERAL", "Particular", "llego", "DEMO-C1", 25000);
    nueva(hoy, "09:20", mS, 2, "CONSULTA MEDICINA GENERAL", "Particular", "confirmado", "DEMO-C1", 25000);
    nueva(hoy, "09:40", mS, 4, "CONSULTA MEDICINA GENERAL", "Particular", "agendado", "DEMO-C1", 25000);
    nueva(hoy, "10:30", mS, 3, "CONSULTA MEDICINA GENERAL", "Particular", "agendado", "DEMO-C1", 25000);
    nueva(hoy, "10:00", mM, 1, "CONSULTA MEDICINA INTERNA", "Particular", "llego", "DEMO-C2", 35000);
    nueva(hoy, "10:30", mM, 5, "CONSULTA MEDICINA INTERNA", "Particular", "agendado", "DEMO-C2", 35000);
    nueva(hoy, "11:00", "rx", 1, "RX DE TÓRAX AP Y LATERAL", "Fonasa", "agendado");
    nueva(hoy, "12:00", "eco", 0, "ECO ABDOMINAL", "Fonasa", "agendado");
    // Próximos días
    nueva(dia(1), "09:00", mS, 1, "CONTROL", "Particular", "agendado", "DEMO-C1", 25000);
    nueva(dia(1), "11:00", mM, 0, "CONSULTA MEDICINA INTERNA", "Particular", "agendado", "DEMO-C2", 35000);
    nueva(dia(2), "10:00", "tc", 3, "TC DE CEREBRO", "Fonasa", "agendado");
    // Atención anterior de Pedro (hace 30 días) con receta y orden, para ver el historial
    const pasada = dia(-30);
    const cPasada = nueva(pasada, "10:00", mM, 1, "CONSULTA MEDICINA INTERNA", "Particular", "atendido", "DEMO-C2", 35000);
    nueva(dia(-25), "09:30", "rx", 1, "RX DE TÓRAX AP Y LATERAL", "Fonasa", "atendido");
    const f = pasada + " 10:12:00";
    const at = Number(db.prepare(`INSERT INTO atenciones (rut, paciente, cita_id, profesional_id, fecha, motivo, anamnesis, examen_fisico, signos, diagnosticos, plan, firmada, firmada_en, creado, actualizado)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run("222222222", pacientes[1][0], cPasada, pMora, f, "Control de presión arterial",
      "Paciente hipertenso en tratamiento, refiere cefalea ocasional matinal. Buena adherencia.", "Buen estado general. Ruidos cardíacos rítmicos, sin soplos. Pulmones limpios.",
      JSON.stringify({ pa: "148/92", fc: "78", peso: "82", talla: "171" }), JSON.stringify([{ codigo: "I10", nombre: "Hipertensión esencial" }]),
      "Aumentar losartán a 100 mg/día. RX de tórax y exámenes de control. Control en 30 días.", f, f, f).lastInsertRowid);
    db.prepare(`INSERT INTO antecedentes (rut, alergias, morbidos, farmacos, habitos, actualizado, actualizado_por) VALUES (?,?,?,?,?,?,?)`)
      .run("222222222", "Penicilina", "Hipertensión arterial (2015)", "Losartán 50 mg cada 24 horas", "Ex fumador", f, uMora);
    const doc = db.prepare("INSERT INTO documentos (tipo, rut, paciente, atencion_id, profesional_id, contenido, codigo, creado) VALUES (?,?,?,?,?,?,?,?)");
    doc.run("receta", "222222222", pacientes[1][0], at, pMora, JSON.stringify({ items: [{ medicamento: "Losartán 100 mg", dosis: "1 comprimido", via: "oral", frecuencia: "cada 24 horas", duracion: "30 días", cantidad: "30 comprimidos", indicaciones: "En la mañana" }], notas: "" }), "DEMO1-RECET", f);
    doc.run("orden", "222222222", pacientes[1][0], at, pMora, JSON.stringify({ area: "laboratorio", examenes: ["Perfil bioquímico", "Perfil lipídico", "Creatinina", "Orina completa"], diagnostico: "I10 Hipertensión esencial", indicaciones: "Ayuno de 8 horas" }), "DEMO2-ORDEN", f);
    db.exec("COMMIT");
    console.log(`Datos de DEMO cargados. Usuarios recepcion, drasoto y drmora con la clave de ADMIN_CLAVE.`);
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("No se pudieron cargar los datos de demo:", e.message);
  }
};
