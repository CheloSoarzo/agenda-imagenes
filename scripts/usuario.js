// Crear o restablecer un usuario desde la consola del servidor.
// Uso: npm run usuario -- <usuario> <clave> [admin|recepcion|lectura]
const db = require("../db");

const [usuario, clave, rol = "admin"] = process.argv.slice(2);
if (!usuario || !clave) {
  console.log("Uso: npm run usuario -- <usuario> <clave> [admin|recepcion|lectura]");
  process.exit(1);
}
if (clave.length < 8) { console.log("La clave debe tener al menos 8 caracteres."); process.exit(1); }
if (!["admin", "recepcion", "lectura"].includes(rol)) { console.log("Rol no válido."); process.exit(1); }

const hash = db.hashClave(clave);
const existe = db.prepare("SELECT id FROM usuarios WHERE usuario = ?").get(usuario);
if (existe) {
  db.prepare("UPDATE usuarios SET clave_hash = ?, rol = ?, activo = 1 WHERE id = ?").run(hash, rol, existe.id);
  console.log(`Usuario "${usuario}" actualizado (rol: ${rol}).`);
} else {
  db.prepare("INSERT INTO usuarios (usuario, nombre, clave_hash, rol) VALUES (?,?,?,?)").run(usuario, usuario, hash, rol);
  console.log(`Usuario "${usuario}" creado (rol: ${rol}).`);
}
