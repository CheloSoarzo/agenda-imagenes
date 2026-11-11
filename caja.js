// Caja: totales de un día o período. Lo usan la pantalla de caja (server.js) y el resumen diario por correo
// (scripts/resumen-caja.js), así ambos muestran exactamente los mismos números.
const db = require("./db");

const CAJA_TZ = process.env.CAJA_TZ || "America/Santiago";
const plainAll = (a) => a.map((o) => (o ? { ...o } : o));

function hoyCaja() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CAJA_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
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

module.exports = { resumenCaja, hoyCaja, CAJA_TZ };
