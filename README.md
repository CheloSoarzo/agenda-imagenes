# Agenda de Imágenes

Agenda web de pacientes por equipo (TC, RX y Ecografía) para centros de imágenes.
El personal ingresa con usuario y clave, y todos ven la misma agenda (se actualiza sola cada 15 segundos).

- Vista por **día** (una columna por equipo) o por **semana** (una columna por día), de 08:00 a 21:00 en bloques de 15 minutos.
- Panel con selector de agenda (TC, RX, Eco o todas), calendario del mes con los días que tienen citas y ocupación del día o semana.
- **Orden médica adjunta** a cada cita: foto (se reduce automáticamente a ~100–300 KB) o PDF, hasta 10 MB. Se guarda dentro de la base de datos, así que el respaldo la incluye.
- Ficha de la cita: paciente, RUT, teléfono, examen, duración, previsión, médico solicitante y notas.
- Estados: agendado, confirmado, llegó, atendido, no asistió y cancelado.
- Las citas que se cruzan en el mismo equipo se muestran lado a lado y marcadas en rojo.
- Búsqueda de pacientes por nombre o RUT.
- Usuarios con tres roles: **Administrador** (todo, incluye crear usuarios), **Recepción** (agenda y edita citas) y **Solo lectura**.
- Registro de quién creó y quién editó por última vez cada cita.
- **Cobro**: al elegir la prestación (código Fonasa) y la previsión, muestra valor, bonificación y copago. Con Fonasa usa el arancel MLE nivel 2; con Particular usa el precio particular del centro; con Isapre o Convenio se ingresa la bonificación del bono.
- **Cierre de caja** diario: totales por medio de pago, previsión y equipo, cuadre de efectivo (esperado vs contado), observaciones, descarga en PDF (con firmas de cajero y supervisor) y en Excel (.xlsx, hojas Resumen y Pagos), e impresión. Una vez cerrada, la caja de ese día no admite pagos ni anulaciones; solo un administrador puede reabrirla.
- **Descuentos** al cobrar: por porcentaje o monto, sobre el copago del paciente (la bonificación del bono no cambia), con motivo obligatorio. Quedan en el pago, en la caja (total y "Descuentos por motivo") y en el PDF, Excel y CSV del cierre.
- **Logos**: cada centro muestra su logo en el ingreso, el encabezado de la agenda, la caja y el PDF del cierre.
- **Aranceles**: mantenedor de prestaciones con valor y bonificación Fonasa nivel 2 y precio particular; permite pegar muchas filas desde Excel.

No usa paquetes externos: solo Node.js. Los datos quedan en un archivo SQLite (`data/agenda.db`).

## Requisitos

- **Node.js 22.13 o superior** (trae SQLite incluido). Revisa con `node -v`.

## Instalar y ejecutar

```bash
cd agenda-imagenes
npm start
```

La primera vez se crea el usuario `admin` y la consola muestra su clave. Entra en `http://IP-DEL-SERVIDOR:3000`, ingresa con ese usuario y cámbiale la clave en **Cambiar clave**.

Si prefieres elegir la clave inicial:

```bash
ADMIN_CLAVE='una-clave-segura' npm start
```

Si olvidas la clave de un usuario, en la consola del servidor:

```bash
npm run usuario -- admin NuevaClave123 admin
```

## Configuración (variables de entorno)

| Variable | Para qué | Valor por defecto |
|---|---|---|
| `PORT` | Puerto web | `3000` |
| `HOST` | Interfaz donde escucha | `0.0.0.0` |
| `DATA_DIR` | Carpeta de la base de datos | `./data` |
| `SESION_HORAS` | Cuánto dura una sesión | `12` |
| `COOKIE_SECURE` | Pon `1` cuando la sirvas con HTTPS | — |
| `TRUST_PROXY` | Pon `1` si está detrás de Nginx u otro proxy | — |
| `CAJA_TZ` | Zona horaria para el día de caja | `America/Santiago` |
| `CENTRO_NOMBRE` | Nombre del centro que se muestra en la agenda, el ingreso y los cierres de caja | — |
| `CENTRO_LOGO` | Archivo de logo en `public/logos` (ingreso, agenda, caja y PDF). Si no se indica, se usa el que coincide con el nombre del centro (`rancagua.png`, `insi.png`) | — |

## Publicarla en Railway (la forma más rápida)

1. Crea una cuenta en https://railway.com y un proyecto nuevo.
2. Sube esta carpeta: con un repositorio de GitHub ("Deploy from GitHub repo") o con la CLI (`railway up` dentro de la carpeta). Railway usa el `Dockerfile` incluido.
3. En el servicio, agrega un **Volume** montado en `/data` (ahí queda la base de datos; sin volumen, se borra en cada actualización).
4. En **Variables** agrega: `DATA_DIR=/data`, `ADMIN_CLAVE=una-clave-segura`, `COOKIE_SECURE=1`, `TRUST_PROXY=1`.
5. En **Settings → Networking** pulsa **Generate Domain** para tener un link HTTPS, o conecta tu propio dominio (por ejemplo `agenda.tucentro.cl`).
6. Entra con el usuario `admin` y la clave que pusiste, y cámbiala.

## Varios centros

Cada centro usa su propia copia de la app, con su propia base de datos, usuarios y caja. En Render: un servicio por centro, todos desde el mismo repositorio de GitHub, cada uno con su disco en `/data`, su `CENTRO_NOMBRE` y su dominio (por ejemplo `agendarancagua.inq.cl` y `agendainsi.inq.cl`). Al subir cambios al repositorio se actualizan todos los centros a la vez.

## Dejarla funcionando en un servidor Linux

1. Copia la carpeta al servidor, por ejemplo a `/opt/agenda-imagenes`.
2. Crea el servicio `/etc/systemd/system/agenda.service`:

```ini
[Unit]
Description=Agenda de Imágenes
After=network.target

[Service]
WorkingDirectory=/opt/agenda-imagenes
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning server.js
Environment=PORT=3000 HOST=127.0.0.1 COOKIE_SECURE=1 TRUST_PROXY=1
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo chown -R www-data /opt/agenda-imagenes
sudo systemctl enable --now agenda
sudo journalctl -u agenda    # aquí aparece la clave inicial de admin
```

3. Publícala con HTTPS usando Nginx (ejemplo para `agenda.tudominio.cl`):

```nginx
server {
  server_name agenda.tudominio.cl;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

```bash
sudo certbot --nginx -d agenda.tudominio.cl
```

**Usa siempre HTTPS**: la agenda tiene datos de pacientes y las claves viajan por la red.

## Respaldos

Un administrador puede descargar en cualquier momento una copia completa de la base de datos con el botón **Respaldo** (arriba, junto a Usuarios). El archivo `agenda-respaldo-AAAA-MM-DD-HH-MM.db` es un SQLite que se abre con cualquier visor (por ejemplo DB Browser for SQLite) y sirve para restaurar: se copia como `agenda.db` en la carpeta de datos con la app detenida. Guárdalo fuera del servidor (Drive, OneDrive, un disco externo); lo ideal es bajar uno al cerrar cada día.

En un servidor propio también puedes automatizarlo:

Toda la información está en `data/agenda.db`. Respáldala a diario, por ejemplo con cron:

```bash
0 23 * * * sqlite3 /opt/agenda-imagenes/data/agenda.db ".backup /respaldos/agenda-$(date +\%F).db"
```

## Aranceles Fonasa

La app trae cargado el grupo 04 del **Libro Arancel MLE 2026 de Fonasa, nivel 2**: 52 radiografías (04-01), 27 tomografías (04-03) y 21 ecografías (04-04). Están en `data-inicial/aranceles-fonasa-2026-nivel2.json`.

En el libro, cada nivel tiene dos columnas: **TOTAL** y **BENEF**. BENEF es lo que paga el beneficiario (copago), así que la bonificación Fonasa es TOTAL − BENEF, y es la misma en los tres niveles.

Puedes ajustar valores, desactivar prestaciones que no hagas y definir precios particulares en **Aranceles**. Cuando una versión nueva de la app trae un arancel actualizado, al iniciar se actualizan valor y bonificación Fonasa sin tocar tus precios particulares, y se recalculan las citas Fonasa que aún no se han pagado. Los pagos ya registrados conservan el valor con que se cobraron.

Libro oficial: https://www.fonasa.gob.cl/wp-content/uploads/sites/3/2026/03/1-Libro-Arancel-MLE-2026.pdf

Cómo se calcula el cobro:

| Previsión | Valor | Bonificación | Copago |
|---|---|---|---|
| Fonasa | Valor N2 del arancel | Bonificación N2 del arancel (se pide el folio del bono) | Valor − bonificación |
| Particular | Precio particular (o valor Fonasa si no tiene) | 0 | Valor completo |
| Isapre / Convenio | Editable | Se ingresa según el bono | Valor − bonificación |

La caja de cada día usa la hora de Chile (`CAJA_TZ=America/Santiago`, configurable).

## Personalizar

En `public/index.html`, al inicio del script:

- `START` y `END`: horario de atención (en minutos desde medianoche; `8*60` = 08:00).
- `EXAMENES`: lista de exámenes sugeridos por equipo.
- `DUR_DEF`: duración por defecto de cada equipo.

## Archivos

```
server.js          servidor web y API
db.js              base de datos, claves y arancel inicial
data-inicial/      arancel Fonasa MLE 2026 nivel 2 precargado
scripts/usuario.js crear o restablecer usuarios desde la consola
public/            páginas (agenda, ingreso y estilos)
data/              base de datos (se crea sola)
```
