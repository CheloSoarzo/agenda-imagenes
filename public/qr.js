/* Generador de códigos QR (modo bytes, corrección de errores nivel M, versiones 1 a 10).
   Sin librerías externas. Uso: qrSVG("https://...", {modulo: 4, margen: 4}) → texto SVG.
   Para la hoja de retiro de la agenda (dirección del portal de exámenes). */
(function (global) {
  "use strict";
  // [total de codewords, ec por bloque, bloques grupo 1, datos por bloque g1, bloques g2, datos g2] — nivel M
  const TABLA = [null,
    [26, 10, 1, 16, 0, 0], [44, 16, 1, 28, 0, 0], [70, 26, 1, 44, 0, 0], [100, 18, 2, 32, 0, 0],
    [134, 24, 2, 43, 0, 0], [172, 16, 4, 27, 0, 0], [196, 18, 4, 31, 0, 0], [242, 22, 2, 38, 2, 39],
    [292, 22, 3, 36, 2, 37], [346, 26, 4, 43, 1, 44]];
  const ALINEA = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // --- aritmética en GF(256) y Reed-Solomon
  const EXP = new Array(512), LOG = new Array(256);
  (function () { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
  function generador(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  }
  function rs(datos, n) {
    const g = generador(n), r = datos.concat(new Array(n).fill(0));
    for (let i = 0; i < datos.length; i++) {
      const c = r[i]; if (!c) continue;
      for (let j = 0; j < g.length; j++) r[i + j] ^= mul(g[j], c);
    }
    return r.slice(datos.length);
  }

  function utf8(txt) { return Array.from(new TextEncoder().encode(txt)); }

  function codificar(txt) {
    const bytes = utf8(txt);
    let v = 1;
    for (; v <= 10; v++) {
      const t = TABLA[v], datos = t[2] * t[3] + t[4] * t[5];
      const bitsCuenta = v < 10 ? 8 : 16;
      if (4 + bitsCuenta + bytes.length * 8 <= datos * 8) break;
    }
    if (v > 10) throw new Error("Texto demasiado largo para el QR");
    const t = TABLA[v], capacidad = t[2] * t[3] + t[4] * t[5];
    // flujo de bits: modo bytes (0100), cantidad, datos, terminador y relleno
    const bits = [];
    const poner = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    poner(4, 4); poner(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => poner(b, 8));
    poner(0, Math.min(4, capacidad * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    for (let p = 0; cw.length < capacidad; p++) cw.push(p % 2 ? 0x11 : 0xEC);
    // bloques y corrección de errores, intercalados
    const bloques = [], ecs = [];
    let k = 0;
    for (let i = 0; i < t[2] + t[4]; i++) {
      const n = i < t[2] ? t[3] : t[5];
      const b = cw.slice(k, k + n); k += n;
      bloques.push(b); ecs.push(rs(b, t[1]));
    }
    const final = [];
    const maxD = Math.max(t[3], t[5]);
    for (let i = 0; i < maxD; i++) bloques.forEach(b => { if (i < b.length) final.push(b[i]); });
    for (let i = 0; i < t[1]; i++) ecs.forEach(e => final.push(e[i]));
    return { v, final };
  }

  function matriz(v, final, mascara) {
    const n = 17 + 4 * v;
    const m = Array.from({ length: n }, () => new Array(n).fill(null));   // null = libre para datos
    const fijo = (x, y, val) => { m[y][x] = val ? 1 : 0; };
    // buscadores (esquinas) con separador
    const buscador = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        fijo(x, y, d !== 2 && d !== 4);
      }
    };
    buscador(3, 3); buscador(n - 4, 3); buscador(3, n - 4);
    // patrones de sincronización
    for (let i = 8; i < n - 8; i++) { fijo(i, 6, i % 2 === 0); fijo(6, i, i % 2 === 0); }
    // alineación
    const pos = ALINEA[v];
    for (const ay of pos) for (const ax of pos) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === n - 7) || (ax === n - 7 && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
        fijo(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // módulo oscuro y reservas de formato / versión
    fijo(8, n - 8, 1);
    for (let i = 0; i < 9; i++) { if (m[8][i] === null) m[8][i] = 0; if (m[i][8] === null) m[i][8] = 0; }
    for (let i = 0; i < 8; i++) { if (m[8][n - 1 - i] === null) m[8][n - 1 - i] = 0; if (m[n - 1 - i][8] === null) m[n - 1 - i][8] = 0; }
    if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { m[i][n - 11 + j] = 0; m[n - 11 + j][i] = 0; }
    const reservado = m.map(f => f.map(c => c !== null));
    // datos en zigzag
    const bits = []; final.forEach(b => { for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); });
    let idx = 0;
    for (let x = n - 1; x >= 1; x -= 2) {
      if (x === 6) x = 5;
      for (let j = 0; j < n; j++) {
        const subiendo = ((n - 1 - x) >> 1) % 2 === 0;
        const y = subiendo ? n - 1 - j : j;
        for (let c = 0; c < 2; c++) {
          const xx = x - c;
          if (reservado[y][xx]) continue;
          let b = idx < bits.length ? bits[idx] : 0; idx++;
          if (aplicaMascara(mascara, xx, y)) b ^= 1;
          m[y][xx] = b;
        }
      }
    }
    // formato (nivel M = 00) y versión
    let f = (0 << 3) | mascara, r = f << 10;
    for (let i = 14; i >= 10; i--) if ((r >> i) & 1) r ^= 0x537 << (i - 10);
    const fmt = ((f << 10) | r) ^ 0x5412;
    const fb = i => (fmt >> i) & 1, pon = (x, y, val) => { m[y][x] = val; };
    for (let i = 0; i <= 5; i++) pon(8, i, fb(i));
    pon(8, 7, fb(6)); pon(8, 8, fb(7)); pon(7, 8, fb(8));
    for (let i = 9; i < 15; i++) pon(14 - i, 8, fb(i));
    for (let i = 0; i < 8; i++) pon(n - 1 - i, 8, fb(i));
    for (let i = 8; i < 15; i++) pon(8, n - 15 + i, fb(i));
    pon(8, n - 8, 1);
    if (v >= 7) {
      let rv = v << 12;
      for (let i = 17; i >= 12; i--) if ((rv >> i) & 1) rv ^= 0x1F25 << (i - 12);
      const vi = (v << 12) | rv;
      for (let i = 0; i < 18; i++) {
        const b = (vi >> i) & 1, a = Math.floor(i / 3), c = n - 11 + (i % 3);
        m[a][c] = b; m[c][a] = b;
      }
    }
    return m;
  }

  function aplicaMascara(k, x, y) {
    switch (k) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  function penalidad(m) {
    const n = m.length; let p = 0;
    for (let eje = 0; eje < 2; eje++) for (let i = 0; i < n; i++) {
      let largo = 1;
      for (let j = 1; j < n; j++) {
        const a = eje ? m[j][i] : m[i][j], b = eje ? m[j - 1][i] : m[i][j - 1];
        if (a === b) largo++; else { if (largo >= 5) p += largo - 2; largo = 1; }
      }
      if (largo >= 5) p += largo - 2;
    }
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
      const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
    const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], tap = pat.slice().reverse();
    for (let y = 0; y < n; y++) for (let x = 0; x <= n - 11; x++) {
      let h1 = true, h2 = true, v1 = true, v2 = true;
      for (let k = 0; k < 11; k++) {
        if (m[y][x + k] !== pat[k]) h1 = false; if (m[y][x + k] !== tap[k]) h2 = false;
        if (m[x + k][y] !== pat[k]) v1 = false; if (m[x + k][y] !== tap[k]) v2 = false;
      }
      p += 40 * (h1 + h2 + v1 + v2);
    }
    let oscuros = 0; m.forEach(f => f.forEach(c => { oscuros += c; }));
    p += Math.floor(Math.abs(oscuros * 20 - n * n * 10) / (n * n)) * 10;
    return p;
  }

  function qrMatriz(txt) {
    const { v, final } = codificar(txt);
    let mejor = null, pMejor = Infinity;
    for (let k = 0; k < 8; k++) {
      const m = matriz(v, final, k), p = penalidad(m);
      if (p < pMejor) { pMejor = p; mejor = m; }
    }
    return mejor;
  }

  function qrSVG(txt, op) {
    op = op || {};
    const m = qrMatriz(txt), n = m.length, mg = op.margen == null ? 4 : op.margen, lado = n + 2 * mg;
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + mg} ${y + mg}h1v1h-1z`;
    const px = (op.modulo || 4) * lado;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="Código QR"><rect width="${lado}" height="${lado}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  global.qrSVG = qrSVG; global.qrMatriz = qrMatriz;
  if (typeof module !== "undefined") module.exports = { qrSVG, qrMatriz };
})(typeof window !== "undefined" ? window : globalThis);
