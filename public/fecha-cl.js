/* Campos de fecha en formato chileno (dd/mm/aaaa), sin importar el idioma del navegador.
 *
 * Cada <input type="date"> se acompaña de un campo de texto dd/mm/aaaa y un botón de calendario.
 * El input original queda oculto y sigue guardando la fecha como siempre (aaaa-mm-dd), así el resto
 * del programa (y los formularios) funcionan igual: leer o asignar .value, eventos input/change, etc.
 * © 2026 MSC26
 */
(function () {
  "use strict";
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  const pad = (n) => String(n).padStart(2, "0");
  const iso2cl = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || "") ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : "");

  function cl2iso(t) {
    const m = String(t || "").trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
    if (!m) return null;
    let [, d, mo, y] = m;
    if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y;
    const f = new Date(Number(y), Number(mo) - 1, Number(d));
    if (f.getFullYear() !== Number(y) || f.getMonth() !== Number(mo) - 1 || f.getDate() !== Number(d)) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }

  const ICONO = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
    'aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';

  function mejorar(orig) {
    if (orig.dataset.fechaCl) return;
    orig.dataset.fechaCl = "1";
    const caja = document.createElement("span");
    caja.className = "fecha-cl";
    const txt = document.createElement("input");
    txt.type = "text";
    txt.inputMode = "numeric";
    txt.autocomplete = "off";
    txt.maxLength = 10;
    txt.placeholder = "dd/mm/aaaa";
    txt.className = "fecha-cl-txt";
    if (orig.id) {
      txt.id = orig.id + "-cl";
      document.querySelectorAll(`label[for="${CSS.escape(orig.id)}"]`).forEach((l) => l.setAttribute("for", txt.id));
    }
    const etiqueta = orig.getAttribute("aria-label") || (orig.closest("label") && orig.closest("label").textContent.trim());
    if (etiqueta) txt.setAttribute("aria-label", etiqueta + " (dd/mm/aaaa)");
    if (orig.required) txt.required = true;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fecha-cl-btn";
    btn.title = "Abrir calendario";
    btn.setAttribute("aria-label", "Abrir calendario");
    btn.innerHTML = ICONO;

    orig.parentNode.insertBefore(caja, orig);
    caja.append(txt, btn, orig);
    orig.classList.add("fecha-cl-oculto");
    orig.tabIndex = -1;
    orig.setAttribute("aria-hidden", "true");

    const actual = () => desc.get.call(orig);
    const sync = () => {
      if (document.activeElement !== txt || !txt.value) txt.value = iso2cl(actual());
      txt.classList.remove("fecha-cl-error");
      txt.disabled = btn.disabled = orig.disabled;
    };
    // Si el programa asigna la fecha (input.value = "2026-11-01"), el texto se actualiza solo
    Object.defineProperty(orig, "value", {
      configurable: true,
      get() { return desc.get.call(orig); },
      set(v) { desc.set.call(orig, v); txt.value = iso2cl(desc.get.call(orig)); txt.classList.remove("fecha-cl-error"); },
    });
    orig.focus = (o) => txt.focus(o);

    const avisar = () => {
      orig.dispatchEvent(new Event("input", { bubbles: true }));
      orig.dispatchEvent(new Event("change", { bubbles: true }));
    };
    function aplicar() {
      const t = txt.value.trim();
      if (!t) {
        txt.classList.remove("fecha-cl-error");
        if (actual() !== "") { desc.set.call(orig, ""); avisar(); }
        return;
      }
      const iso = cl2iso(t);
      if (!iso) { txt.classList.add("fecha-cl-error"); txt.title = "Fecha no válida. Usa dd/mm/aaaa"; return; }
      txt.classList.remove("fecha-cl-error");
      txt.removeAttribute("title");
      txt.value = iso2cl(iso);
      if (iso !== actual()) { desc.set.call(orig, iso); avisar(); }
    }
    txt.addEventListener("input", (e) => {
      if (e.inputType && e.inputType.startsWith("delete")) return;
      const d = txt.value.replace(/\D/g, "").slice(0, 8);
      let s = d.slice(0, 2);
      if (d.length > 2) s += "/" + d.slice(2, 4);
      if (d.length > 4) s += "/" + d.slice(4);
      txt.value = s;
      if (d.length === 8) aplicar();
    });
    txt.addEventListener("blur", aplicar);
    txt.addEventListener("keydown", (e) => { if (e.key === "Enter") aplicar(); });
    // Calendario propio (el del navegador quedaba pegado en Safari y tapaba la página)
    btn.addEventListener("click", (e) => { e.stopPropagation(); calendario.abrir(caja, actual(), (iso) => {
      desc.set.call(orig, iso); txt.value = iso2cl(iso); txt.classList.remove("fecha-cl-error"); avisar(); txt.focus();
    }, orig.min, orig.max); });
    // La fecha elegida en el calendario se copia al texto
    orig.addEventListener("input", sync);
    orig.addEventListener("change", sync);
    new MutationObserver(sync).observe(orig, { attributes: true, attributeFilter: ["disabled"] });
    sync();
  }

  // ---------- calendario emergente (uno solo para toda la página) ----------
  const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const calendario = {
    el: null, ancla: null, elegir: null, mes: null, sel: "", min: "", max: "",
    abrir(ancla, valor, elegir, min, max) {
      if (this.el && this.ancla === ancla) { this.cerrar(); return; }
      this.cerrar();
      this.ancla = ancla; this.elegir = elegir; this.sel = valor || ""; this.min = min || ""; this.max = max || "";
      const base = /^\d{4}-\d{2}-\d{2}$/.test(valor || "") ? new Date(+valor.slice(0, 4), +valor.slice(5, 7) - 1, 1) : new Date();
      this.mes = new Date(base.getFullYear(), base.getMonth(), 1);
      const el = this.el = document.createElement("div");
      el.className = "cal-pop"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Elegir fecha");
      el.addEventListener("click", (e) => e.stopPropagation());
      el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.cerrar(true); } });
      document.body.appendChild(el);
      this.pintar(); this.ubicar();
      const foco = el.querySelector(".cal-dia.sel") || el.querySelector(".cal-dia.hoy") || el.querySelector(".cal-dia");
      if (foco) foco.focus();
    },
    ubicar() {
      const r = this.ancla.getBoundingClientRect(), el = this.el, w = el.offsetWidth, h = el.offsetHeight;
      let x = Math.min(r.left, innerWidth - w - 8), y = r.bottom + 4;
      if (y + h > innerHeight - 8 && r.top - h - 4 > 8) y = r.top - h - 4;
      el.style.left = Math.max(8, x) + "px"; el.style.top = Math.max(8, y) + "px";
    },
    pintar() {
      const m = this.mes, hoy = iso(new Date());
      let h = `<div class="cal-cab"><button type="button" class="cal-nav" data-k="-1" aria-label="Mes anterior">‹</button>
        <span class="cal-sel"><select class="cal-mes" aria-label="Mes">${MESES.map((t, i) => `<option value="${i}"${i === m.getMonth() ? " selected" : ""}>${t}</option>`).join("")}</select>
        <select class="cal-anio" aria-label="Año">${this.anios(m.getFullYear())}</select></span>
        <button type="button" class="cal-nav" data-k="1" aria-label="Mes siguiente">›</button></div><div class="cal-grid">`;
      for (const d of ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"]) h += `<span class="cal-dow">${d}</span>`;
      for (let i = 0; i < (m.getDay() + 6) % 7; i++) h += "<span></span>";
      const n = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      for (let d = 1; d <= n; d++) {
        const f = iso(new Date(m.getFullYear(), m.getMonth(), d));
        const fuera = (this.min && f < this.min) || (this.max && f > this.max);
        h += `<button type="button" class="cal-dia${f === hoy ? " hoy" : ""}${f === this.sel ? " sel" : ""}" data-f="${f}"${fuera ? " disabled" : ""}>${d}</button>`;
      }
      h += `</div><div class="cal-pie"><button type="button" class="cal-hoy">Hoy</button><button type="button" class="cal-cerrar">Cerrar</button></div>`;
      this.el.innerHTML = h;
      this.el.querySelectorAll(".cal-nav").forEach((b) => b.addEventListener("click", () => {
        this.mes = new Date(this.mes.getFullYear(), this.mes.getMonth() + Number(b.dataset.k), 1); this.pintar();
        this.el.querySelector(`.cal-nav[data-k="${b.dataset.k}"]`).focus();
      }));
      const cambiar = () => {
        this.mes = new Date(Number(this.el.querySelector(".cal-anio").value), Number(this.el.querySelector(".cal-mes").value), 1); this.pintar();
      };
      this.el.querySelector(".cal-mes").addEventListener("change", cambiar);
      this.el.querySelector(".cal-anio").addEventListener("change", cambiar);
      this.el.querySelectorAll(".cal-dia").forEach((b) => b.addEventListener("click", () => this.listo(b.dataset.f)));
      this.el.querySelector(".cal-hoy").addEventListener("click", () => this.listo(hoy));
      this.el.querySelector(".cal-cerrar").addEventListener("click", () => this.cerrar(true));
    },
    anios(actual) {
      const hoyA = new Date().getFullYear();
      const desde = this.min ? Number(this.min.slice(0, 4)) : Math.min(actual, hoyA) - 110;
      const hasta = this.max ? Number(this.max.slice(0, 4)) : Math.max(actual, hoyA) + 5;
      let h = "";
      for (let a = hasta; a >= desde; a--) h += `<option value="${a}"${a === actual ? " selected" : ""}>${a}</option>`;
      return h;
    },
    listo(f) { const cb = this.elegir; this.cerrar(); if (cb) cb(f); },
    cerrar(volverFoco) {
      if (!this.el) return;
      const a = this.ancla; this.el.remove(); this.el = null; this.ancla = null;
      if (volverFoco && a) { const t = a.querySelector(".fecha-cl-txt"); if (t) t.focus(); }
    },
  };
  document.addEventListener("click", () => calendario.cerrar());
  addEventListener("resize", () => calendario.cerrar());
  addEventListener("scroll", (e) => { if (calendario.el && !calendario.el.contains(e.target)) calendario.cerrar(); }, true);

  function mejorarTodo(raiz) {
    (raiz.querySelectorAll ? raiz : document).querySelectorAll('input[type="date"]').forEach(mejorar);
  }
  const iniciar = () => {
    mejorarTodo(document);
    new MutationObserver((cambios) => cambios.forEach((c) => c.addedNodes.forEach((n) => {
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches('input[type="date"]')) mejorar(n); else mejorarTodo(n);
    }))).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar); else iniciar();
  window.FechaCL = { iso2cl, cl2iso };
})();
