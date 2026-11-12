// Caja: totales de un día o período. Lo usan la pantalla de caja (server.js) y el resumen diario por correo
// (scripts/resumen-caja.js), así ambos muestran exactamente los mismos números.
const db = require("./db");

const CAJA_TZ = process.env.CAJA_TZ || "America/Santiago";
const plainAll = (a) => a.map((o) => (o ? { ...o } : o));

function hoyCaja() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CAJA_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// ---------- Tarjetas (Klap): comisión y depósito estimado ----------
// Feriados nacionales de Chile (para el día hábil del depósito). Actualizar cada año (igual que en public/index.html).
const FERIADOS = new Set([
  "2026-01-01", "2026-04-03", "2026-04-04", "2026-05-01", "2026-05-21", "2026-06-21", "2026-06-29", "2026-07-16", "2026-08-15",
  "2026-09-18", "2026-09-19", "2026-10-12", "2026-10-31", "2026-11-01", "2026-12-08", "2026-12-25",
  "2027-01-01", "2027-03-26", "2027-03-27", "2027-05-01", "2027-05-21", "2027-06-21", "2027-06-28", "2027-07-16", "2027-08-15",
  "2027-09-17", "2027-09-18", "2027-09-19", "2027-10-11", "2027-10-31", "2027-11-01", "2027-12-08", "2027-12-25"]);
function habilSiguiente(fecha, dias = 1) {
  const d = new Date(fecha + "T12:00:00Z");
  while (dias > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10), w = d.getUTCDay();
    if (w !== 0 && w !== 6 && !FERIADOS.has(iso)) dias--;
  }
  return d.toISOString().slice(0, 10);
}
// Valores referenciales de Klap (POS); cada comercio tiene su contrato: se cambian en Caja → «Comisiones tarjetas»
const TARJETAS_DEF = { proveedor: "Klap", debito: 0.62, credito: 1.39, fijo: 77, iva: true, dias: 1 };
function configTarjetas() {
  let c = {};
  try { c = JSON.parse(db.prepare("SELECT valor FROM meta WHERE clave = 'tarjetas'").get()?.valor || "{}"); } catch { c = {}; }
  return { ...TARJETAS_DEF, ...c };
}
function guardarTarjetas(b) {
  const num = (v, max) => { const n = Number(String(v ?? "").replace(",", ".")); if (!isFinite(n) || n < 0 || n > max) throw new Error("Valor no válido"); return n; };
  const c = { proveedor: String(b.proveedor || "Klap").slice(0, 40), debito: num(b.debito, 10), credito: num(b.credito, 10),
    fijo: num(b.fijo, 5000), iva: !!b.iva, dias: Math.round(num(b.dias ?? 1, 10)) || 1 };
  db.prepare("INSERT INTO meta (clave, valor) VALUES ('tarjetas', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(JSON.stringify(c));
  return c;
}
// Ventas con tarjeta de los pagos válidos → comisión aproximada y lo que debería depositarse (por día de depósito)
function calcularTarjetas(validos, partes) {
  const cfg = configTarjetas(), IVA = cfg.iva ? 0.19 : 0;
  const tipo = { "Débito": "debito", "Crédito": "credito" };
  const r = { config: cfg, debito: { cantidad: 0, bruto: 0, comision: 0 }, credito: { cantidad: 0, bruto: 0, comision: 0 },
    bruto: 0, comision: 0, iva: 0, neto: 0, depositos: [] };
  const dep = {};
  for (const p of validos) for (const [m, monto] of partes(p)) {
    const t = tipo[m]; if (!t || !(monto > 0)) continue;
    const com = monto * cfg[t] / 100 + cfg.fijo, iva = com * IVA;
    r[t].cantidad++; r[t].bruto += monto; r[t].comision += com;
    r.bruto += monto; r.comision += com; r.iva += iva;
    const f = habilSiguiente(p.fecha, cfg.dias);
    const d = (dep[f] = dep[f] || { fecha: f, ventas: new Set(), bruto: 0, neto: 0 });
    d.ventas.add(p.fecha); d.bruto += monto; d.neto += monto - com - iva;
  }
  r.neto = r.bruto - r.comision - r.iva;
  for (const k of ["bruto", "comision", "iva", "neto"]) r[k] = Math.round(r[k]);
  for (const t of ["debito", "credito"]) { r[t].bruto = Math.round(r[t].bruto); r[t].comision = Math.round(r[t].comision); }
  r.depositos = Object.values(dep).sort((a, b) => a.fecha.localeCompare(b.fecha))
    .map((d) => ({ fecha: d.fecha, ventas: [...d.ventas].sort(), bruto: Math.round(d.bruto), neto: Math.round(d.neto) }));
  return r;
}

// Resumen de caja de un día o de un período (desde–hasta, ambos incluidos)
function resumenCaja(desde, hasta = desde) {
  const pagos = plainAll(db.prepare(`SELECT p.*, u.nombre AS usuario_nombre, ua.nombre AS anulado_por_nombre
    FROM pagos p LEFT JOIN usuarios u ON u.id = p.usuario_id LEFT JOIN usuarios ua ON ua.id = p.anulado_por
    WHERE p.fecha BETWEEN ? AND ? ORDER BY p.fecha, p.creado`).all(desde, hasta));
  const pesosTxt = (n) => "$" + Math.round(n || 0).toLocaleString("es-CL");
  for (const p of pagos) p.medio_txt = (p.monto2 > 0 ? `${p.medio} ${pesosTxt(p.copago - p.monto2)} + ${p.medio2} ${pesosTxt(p.monto2)}` : p.medio)
    + (p.cheque ? ` (cheque ${p.cheque})` : "");
  const validos = pagos.filter((p) => !p.anulado);
  const suma = (arr, k) => arr.reduce((t, p) => t + (p[k] || 0), 0);
  // Partes de cada pago por medio (un pago dividido aporta a dos medios)
  const partes = (p) => (p.monto2 > 0 ? [[p.medio, p.copago - p.monto2, true], [p.medio2, p.monto2, false]] : [[p.medio, p.copago, true]]);
  const efectivoDe = (p) => partes(p).filter(([m]) => m === "Efectivo").reduce((t, [, x]) => t + x, 0);
  const porMedio = (lista) => {
    const o = {};
    for (const p of lista) for (const [m, monto, principal] of partes(p)) {
      const g = (o[m] = o[m] || { cantidad: 0, valor: 0, bonificacion: 0, copago: 0, descuento: 0 });
      g.cantidad++; g.copago += monto;
      if (principal) { g.valor += p.valor; g.bonificacion += p.bonificacion; g.descuento += p.descuento || 0; }
    }
    return o;
  };
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
    por_medio: porMedio(validos),
    por_prevision: agrupar("prevision", validos),
    por_equipo: agrupar("equipo", validos),
    efectivo_esperado: validos.reduce((t, p) => t + efectivoDe(p), 0),
    tarjetas: calcularTarjetas(validos, partes),
  };
  const cierres = plainAll(db.prepare(`SELECT c.*, u.nombre AS usuario_nombre FROM cierres c LEFT JOIN usuarios u ON u.id = c.usuario_id
    WHERE c.fecha BETWEEN ? AND ? ORDER BY c.fecha`).all(desde, hasta)).map((c) => ({ ...c, resumen: JSON.parse(c.resumen) }));
  // Detalle por día (para períodos de varios días)
  const dias = {};
  for (const p of validos) {
    const d = (dias[p.fecha] = dias[p.fecha] || { fecha: p.fecha, atenciones: 0, valor: 0, bonificacion: 0, descuentos: 0, recaudado: 0, efectivo_esperado: 0 });
    d.atenciones++; d.valor += p.valor; d.bonificacion += p.bonificacion; d.descuentos += p.descuento || 0; d.recaudado += p.copago;
    d.efectivo_esperado += efectivoDe(p);
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

module.exports = { resumenCaja, hoyCaja, CAJA_TZ, configTarjetas, guardarTarjetas, habilSiguiente };
