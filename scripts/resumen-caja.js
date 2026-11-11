// Totales de caja de un día en JSON, para el resumen diario por correo del servidor (pacs resumen).
// Uso: node scripts/resumen-caja.js --fecha 2026-11-10   (sin --fecha: hoy)
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
  por_medio: solo(t.por_medio), por_prevision: solo(t.por_prevision), por_equipo: solo(t.por_equipo),
  cierre: r.cierre ? { efectivo_contado: r.cierre.efectivo_contado, diferencia: r.cierre.diferencia,
    por: r.cierre.usuario_nombre || "", observaciones: r.cierre.observaciones || "" } : null,
}));
