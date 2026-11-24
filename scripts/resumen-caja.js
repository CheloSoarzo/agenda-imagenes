// Totales de caja en JSON, para los resúmenes por correo del servidor (pacs resumen-caja).
// Uso: node scripts/resumen-caja.js --fecha 2026-11-10 [--detalle]   (un día; sin --fecha: hoy; --detalle: cada pago, para el PDF)
//      node scripts/resumen-caja.js --desde 2026-11-09 --hasta 2026-11-14   (período: totales y detalle por día, sin pacientes)
const { resumenCaja, hoyCaja, cajas: listaCajas } = require("../caja");

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : ""; };
const desde = arg("--desde") || arg("--fecha") || hoyCaja();
const hasta = arg("--hasta") || desde;
const ok = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || "");
if (!ok(desde) || !ok(hasta) || hasta < desde) { console.log(JSON.stringify({ error: "fecha no válida" })); process.exit(1); }
const fecha = desde, periodo = hasta !== desde;
// Nombre de las agendas de médicos (m1, m2…) para el correo
function nombresAgendas() {
  try { return Object.fromEntries(require("../db").prepare("SELECT id, nombre FROM profesionales").all().map((p) => ["m" + p.id, p.nombre])); }
  catch { return {}; }
}
const r = resumenCaja(desde, hasta);
const t = r.totales;
// Varias cajas (cada una con su cierre): detalle por caja; un día está cerrado cuando todas las cajas con pagos lo están
const CJ = listaCajas();
let porCaja;
if (CJ.length) {
  const todas = [{ id: 0, nombre: "General" }, ...CJ];
  const res = todas.map((c) => ({ c, r: resumenCaja(desde, hasta, { caja: c.id }) }));
  porCaja = res.filter(({ c, r: x }) => c.id || x.totales.atenciones || x.cierres.length).map(({ c, r: x }) => ({
    nombre: c.nombre, atenciones: x.totales.atenciones, recaudado: x.totales.recaudado, efectivo_esperado: x.totales.efectivo_esperado,
    cierre: x.cierre ? { efectivo_contado: x.cierre.efectivo_contado, diferencia: x.cierre.diferencia, por: x.cierre.usuario_nombre || "", observaciones: x.cierre.observaciones || "" } : null,
    diferencias: x.totales.diferencias }));
  if (periodo) {
    for (const d of r.por_dia) {
      const conPagos = res.filter(({ r: x }) => x.pagos.some((p) => p.fecha === d.fecha && !p.anulado));
      d.cerrada = conPagos.length > 0 && conPagos.every(({ r: x }) => x.cierres.some((ci) => ci.fecha === d.fecha));
      d.diferencia = res.reduce((s, { r: x }) => s + x.cierres.filter((ci) => ci.fecha === d.fecha).reduce((a, ci) => a + ci.diferencia, 0), 0);
    }
    t.diferencias = res.reduce((s, { r: x }) => s + (x.totales.diferencias || 0), 0);
  }
}
const solo = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, { cantidad: v.cantidad, monto: v.copago }]));
console.log(JSON.stringify({
  fecha,
  atenciones: t.atenciones, valor: t.valor, bonificacion: t.bonificacion, recaudado: t.recaudado,
  descuentos: t.descuentos, con_descuento: t.con_descuento, anulados: t.anulados,
  efectivo_esperado: t.efectivo_esperado,
  contraste: t.contraste,
  tarjetas: t.tarjetas && t.tarjetas.bruto > 0 ? { proveedor: t.tarjetas.config.proveedor, bruto: t.tarjetas.bruto,
    comision: t.tarjetas.comision, iva: t.tarjetas.iva, neto: t.tarjetas.neto, depositos: t.tarjetas.depositos,
    debito: { ...t.tarjetas.debito, tasa: t.tarjetas.config.debito }, credito: { ...t.tarjetas.credito, tasa: t.tarjetas.config.credito },
    fijo: t.tarjetas.config.fijo, fijo_uf: t.tarjetas.config.fijo_uf } : null,
  por_medio: solo(t.por_medio), por_prevision: solo(t.por_prevision), por_equipo: solo(t.por_equipo),
  desde, hasta,
  por_dia: periodo ? r.por_dia.map((d) => ({ fecha: d.fecha, atenciones: d.atenciones, recaudado: d.recaudado,
    efectivo_esperado: d.efectivo_esperado, cerrada: d.cerrada, diferencia: d.diferencia })) : undefined,
  diferencias: periodo ? t.diferencias : undefined,
  pagos: !periodo && process.argv.includes("--detalle") ? r.pagos.map((p) => ({
    hora: String(p.creado || "").slice(11, 16), paciente: p.paciente, rut: p.rut, examen: p.examen, equipo: p.equipo,
    prevision: p.prevision, valor: p.valor, bonificacion: p.bonificacion, descuento: p.descuento || 0, copago: p.copago,
    medio: p.medio_txt, boleta: p.boleta || "", contraste: p.contraste || 0, boleta_contraste: p.boleta_contraste || "", folio_bono: p.folio_bono || "", usuario: p.usuario_nombre || "",
    anulado: !!p.anulado, motivo_anulacion: p.motivo_anulacion || "" })) : undefined,
  cajas: porCaja,
  nombres: nombresAgendas(),
  cierre: r.cierre ? { efectivo_contado: r.cierre.efectivo_contado, diferencia: r.cierre.diferencia,
    por: r.cierre.usuario_nombre || "", observaciones: r.cierre.observaciones || "" } : null,
}));
