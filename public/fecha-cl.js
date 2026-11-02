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
    btn.addEventListener("click", () => {
      try { orig.showPicker(); } catch (err) { txt.focus(); }
    });
    // La fecha elegida en el calendario se copia al texto
    orig.addEventListener("input", sync);
    orig.addEventListener("change", sync);
    new MutationObserver(sync).observe(orig, { attributes: true, attributeFilter: ["disabled"] });
    sync();
  }

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
