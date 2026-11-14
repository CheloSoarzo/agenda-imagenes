// Totales de caja de un día en JSON, para el resumen diario por correo del servidor (pacs resumen).
// Uso: node scripts/resumen-caja.js --fecha 2026-11-10 [--detalle]   (sin --fecha: hoy; --detalle: cada pago, para el PDF)
const { resumenCaja, hoyCaja } = require("../caja");

const i = process.argv.indexOf("--fecha");
const fecha = i > 0 ? process.argv[i + 1] : hoyCaja();
if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || "")) { console.log(JSON.stringify({ error: "fecha no válida" })); process.exit(1); }
const r = resumenCaja(fecha);
const t = r.totales;
const solo = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, { cantidad: v.cantidad, monto: v.copago }]));
console.log(JSON.stringify({
  fecha,
  atenciones: t.atenciones, valor: t.valor, bonificacion: t.bonificacion, recaudado: t.recaudado,
  descuentos: t.descuentos, con_descuento: t.con_descuento, anulados: t.anulados,
  efectivo_esperado: t.efectivo_esperado,
  tarjetas: t.tarjetas && t.tarjetas.bruto > 0 ? { proveedor: t.tarjetas.config.proveedor, bruto: t.tarjetas.bruto,
    comision: t.tarjetas.comision, iva: t.tarjetas.iva, neto: t.tarjetas.neto, depositos: t.tarjetas.depositos,
    debito: { ...t.tarjetas.debito, tasa: t.tarjetas.config.debito }, credito: { ...t.tarjetas.credito, tasa: t.tarjetas.config.credito },
    fijo: t.tarjetas.config.fijo, fijo_uf: t.tarjetas.config.fijo_uf } : null,
  por_medio: solo(t.por_medio), por_prevision: solo(t.por_prevision), por_equipo: solo(t.por_equipo),
  pagos: process.argv.includes("--detalle") ? r.pagos.map((p) => ({
    hora: String(p.creado || "").slice(11, 16), paciente: p.paciente, rut: p.rut, examen: p.examen, equipo: p.equipo,
    prevision: p.prevision, valor: p.valor, bonificacion: p.bonificacion, descuento: p.descuento || 0, copago: p.copago,
    medio: p.medio_txt, boleta: p.boleta || "", folio_bono: p.folio_bono || "", usuario: p.usuario_nombre || "",
    anulado: !!p.anulado, motivo_anulacion: p.motivo_anulacion || "" })) : undefined,
  cierre: r.cierre ? { efectivo_contado: r.cierre.efectivo_contado, diferencia: r.cierre.diferencia,
    por: r.cierre.usuario_nombre || "", observaciones: r.cierre.observaciones || "" } : null,
}));
