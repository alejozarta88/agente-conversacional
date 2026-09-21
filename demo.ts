import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { declarar, ejecutar } from "./src/tools/contrato.js";
import { EXIGEN_APROBACION, REGISTRO_AGENTE } from "./src/registro.js";

/**
 * Demo del reto 02, sin clave, sin red y sin modelo: llama a las cinco
 * herramientas en el orden del flujo e imprime lo que decide cada una.
 *
 * El PRD lo especifica literalmente: "los mensajes con requiere_revision
 * no vacio deben quedar SIN registrar en la primera pasada, y la demo debe
 * mostrar una segunda llamada con confirmado: true para uno de ellos".
 */

const FECHA_CORTE = "2026-09-03";
const MENSAJES = [
  "msg-001",
  "msg-002",
  "msg-003",
  "msg-004",
  "msg-005",
  "msg-006",
];

// ---------------------------------------------------------------------------
// Utilidades de presentacion
// ---------------------------------------------------------------------------

function titulo(texto: string): void {
  console.log("");
  console.log(`=== ${texto} ${"=".repeat(Math.max(0, 68 - texto.length))}`);
  console.log("");
}

interface Sobre {
  ok: boolean;
  data?: unknown;
  error?: string;
}

async function llamar(nombre: string, argumentos: unknown): Promise<Sobre> {
  const crudo = await ejecutar(REGISTRO_AGENTE, nombre, argumentos);
  const analizado: unknown = JSON.parse(crudo);
  if (typeof analizado !== "object" || analizado === null) {
    return { ok: false, error: "sobre ilegible" };
  }
  const sobre = analizado as Sobre;
  return sobre;
}

/** Lee una propiedad sin recurrir a any. */
function campo(valor: unknown, clave: string): unknown {
  if (typeof valor !== "object" || valor === null) {
    return undefined;
  }
  return (valor as Record<string, unknown>)[clave];
}

function texto(valor: unknown): string {
  return typeof valor === "string" ? valor : "";
}

function lista(valor: unknown): readonly unknown[] {
  return Array.isArray(valor) ? valor : [];
}

// ---------------------------------------------------------------------------
// Arranque limpio
// ---------------------------------------------------------------------------

const raizOut = resolve(process.cwd(), "out");
for (const entrada of ["sharepoint", "procesados.json", "alertas.md", "log.jsonl"]) {
  rmSync(join(raizOut, entrada), { recursive: true, force: true });
}

console.log("DEMO — Registro de contratos vigentes (reto 02)");
console.log("Sin clave, sin red y sin modelo: se llaman las herramientas directamente.");
console.log(`Fecha de corte para las alertas: ${FECHA_CORTE}`);
console.log(`Estado de salida limpiado: ${raizOut}`);

titulo("Herramientas declaradas al modelo");
for (const declaracion of declarar(REGISTRO_AGENTE)) {
  const marca = EXIGEN_APROBACION.includes(declaracion.name)
    ? "  [exige aprobacion humana]"
    : "";
  console.log(`  - ${declaracion.name}${marca}`);
}
console.log("");
console.log(
  `  De las ${declarar(REGISTRO_AGENTE).length}, solo ${EXIGEN_APROBACION.length} se detiene antes de ejecutarse:`,
);
console.log(`  ${EXIGEN_APROBACION.join(", ")}. Es la unica que escribe datos del negocio.`);

// ---------------------------------------------------------------------------
// 1. El buzon
// ---------------------------------------------------------------------------

titulo("1. Buzon: mensajes sin procesar");

const buzon = await llamar("contratos_leer_buzon", {});
for (const mensaje of lista(campo(buzon.data, "mensajes"))) {
  const conContrato = campo(mensaje, "tiene_contrato") === true;
  console.log(
    `  ${texto(campo(mensaje, "id"))}  ${conContrato ? "[contrato]  " : "[sin contrato]"}  ${texto(campo(mensaje, "asunto"))}`,
  );
  console.log(
    `           de ${texto(campo(mensaje, "de"))}  adjuntos: ${lista(campo(mensaje, "adjuntos")).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Primera pasada
// ---------------------------------------------------------------------------

titulo("2. Primera pasada: extraer, validar y registrar");

interface Resultado {
  mensaje: string;
  clasificacion: string;
  regla: string;
  accion: string;
  detalle: string;
  enRevision: readonly string[];
}

const resultados: Resultado[] = [];

for (const mensajeId of MENSAJES) {
  console.log(`--- ${mensajeId} ---`);

  const extraccion = await llamar("contratos_extraer", { mensaje_id: mensajeId });
  const tipo = texto(campo(extraccion.data, "tipo_documento"));
  console.log(`  extraer:   tipo de documento = ${tipo}`);

  const juicio = await llamar("contratos_validar", { mensaje_id: mensajeId });
  const clasificacion = texto(campo(juicio.data, "clasificacion"));
  const regla = texto(campo(juicio.data, "regla"));
  const motivo = texto(campo(juicio.data, "motivo"));
  const enRevision = lista(campo(juicio.data, "requiere_revision")).map((linea) =>
    texto(linea),
  );
  const comprobante = texto(campo(juicio.data, "comprobante"));
  const comercial = campo(juicio.data, "comercial");
  console.log(`  validar:   ${clasificacion.toUpperCase()} (${regla})`);
  if (motivo !== "") {
    console.log(`             ${motivo}`);
  }
  if (campo(comercial, "conocido") === false) {
    console.log(
      `             AVISO: remitente ${texto(campo(comercial, "email"))} no esta en comerciales.json`,
    );
  }

  // RN5: los campos en revision se muestran UNO POR UNO, con su confianza.
  if (enRevision.length > 0) {
    console.log(`             ${enRevision.length} campos necesitan revision:`);
    for (const linea of enRevision) {
      console.log(`               - ${linea}`);
    }
  }

  // El comprobante sale de validar. Sin el, registrar no escribe nada:
  // el flujo es una precondicion del codigo, no una sugerencia.
  const registro = await llamar("contratos_registrar", {
    mensaje_id: mensajeId,
    confirmado: false,
    hoy: FECHA_CORTE,
    comprobante,
  });

  let accion: string;
  let detalle: string;
  if (!registro.ok) {
    accion = "NO REGISTRADO";
    detalle = texto(registro.error);
    console.log(`  registrar: NO SE ESCRIBIO NADA`);
    console.log(`             ${detalle.slice(0, 140)}`);
  } else {
    accion = texto(campo(registro.data, "accion"));
    const escrituras = lista(campo(registro.data, "escrituras"));
    const aviso = texto(campo(registro.data, "aviso"));
    detalle = aviso === "" ? `${escrituras.length} escrituras` : aviso;
    console.log(`  registrar: ${accion}  (${escrituras.length} escrituras)`);
    const ruta = texto(campo(registro.data, "ruta_archivo"));
    if (ruta !== "") {
      console.log(`             archivado en ${ruta}`);
      console.log(`             ${texto(campo(campo(registro.data, "archivado"), "explicacion"))}`);
    }
    if (aviso !== "") {
      console.log(`             ${aviso}`);
    }
  }

  resultados.push({ mensaje: mensajeId, clasificacion, regla, accion, detalle, enRevision });
  console.log("");
}

// ---------------------------------------------------------------------------
// 3. Segunda llamada con aprobacion humana
// ---------------------------------------------------------------------------

titulo("3. Segunda llamada: una persona aprueba msg-006 y corrige dos campos");

console.log("En la primera pasada msg-006 quedo sin registrar: es un contrato marco");
console.log("con valor por demanda y un plazo que corre desde una firma sin dia.");
console.log("");
console.log("En el chat, esta llamada se detiene antes de ejecutarse y le muestra a la");
console.log("persona los datos exactos campo por campo. Aqui se llama directamente,");
console.log("simulando que ya los aprobo:");
console.log("");
console.log('  "confirmo el valor 0 y la fecha fin 2027-08-31"');
console.log("");

// Se vuelve a validar: el maestro cambio con los registros anteriores, y
// el comprobante de la primera pasada ya no corresponde a este estado.
const revalidado = await llamar("contratos_validar", { mensaje_id: "msg-006" });
const confirmado = await llamar("contratos_registrar", {
  mensaje_id: "msg-006",
  confirmado: true,
  hoy: FECHA_CORTE,
  comprobante: texto(campo(revalidado.data, "comprobante")),
  correcciones: { valor: 0, fecha_fin: "2027-08-31" },
});

if (confirmado.ok) {
  console.log(`  accion:      ${texto(campo(confirmado.data, "accion"))}`);
  console.log(`  archivado:   ${texto(campo(confirmado.data, "ruta_archivo"))}`);
  console.log(`  procedencia: ${texto(campo(confirmado.data, "resumen_procedencia"))}`);
  const indice = resultados.findIndex((fila) => fila.mensaje === "msg-006");
  const previo = resultados[indice];
  if (previo !== undefined) {
    resultados[indice] = {
      ...previo,
      accion: `${texto(campo(confirmado.data, "accion"))} (tras aprobacion)`,
      detalle: texto(campo(confirmado.data, "resumen_procedencia")),
    };
  }
} else {
  console.log(`  FALLO: ${texto(confirmado.error)}`);
}

// ---------------------------------------------------------------------------
// 4. Alertas
// ---------------------------------------------------------------------------

titulo(`4. Reporte de alertas con fecha de corte ${FECHA_CORTE}`);

const alertas = await llamar("contratos_alertas", { hoy: FECHA_CORTE });
if (!alertas.ok) {
  console.log(`  FALLO: ${texto(alertas.error)}`);
} else {
  const datos = alertas.data;
  console.log(`  ${texto(campo(datos, "resumen"))}`);
  console.log("");
  const grupos: readonly [string, string][] = [
    ["vencidos", "Ya vencidos"],
    ["vencen", "Vencen en 60 dias o menos"],
    ["polizas_pendientes", "Poliza exigida sin vigencia confirmada"],
    ["registrados_desde_corte", "Registrados desde el inicio del gap"],
  ];
  for (const [clave, rotulo] of grupos) {
    const filas = lista(campo(datos, clave));
    console.log(`  ${rotulo} (${filas.length})`);
    for (const fila of filas) {
      const dias = campo(fila, "dias");
      const sufijo =
        typeof dias === "number"
          ? dias < 0
            ? `vencio hace ${Math.abs(dias)} dias`
            : `faltan ${dias} dias`
          : texto(campo(fila, "estado_poliza")) ||
            texto(campo(fila, "fecha_registro"));
      console.log(
        `    - ${texto(campo(fila, "id_contrato"))}  ${texto(campo(fila, "cliente"))}  (${sufijo})`,
      );
    }
  }
  const remitentes = lista(campo(datos, "remitentes_no_resueltos"));
  console.log(`  Remitentes sin resolver (${remitentes.length})`);
  for (const fila of remitentes) {
    console.log(
      `    - ${texto(campo(fila, "email"))}  (${texto(campo(fila, "detalle"))})`,
    );
  }
  console.log("");
  console.log(`  Reporte escrito en ${texto(campo(datos, "ruta"))}`);
}

// ---------------------------------------------------------------------------
// 5. Resumen
// ---------------------------------------------------------------------------

titulo("5. Resumen: que paso con cada mensaje");

const ancho = { mensaje: 9, clasificacion: 21, accion: 26 };
console.log(
  `  ${"MENSAJE".padEnd(ancho.mensaje)}${"VEREDICTO".padEnd(ancho.clasificacion)}${"ACCION".padEnd(ancho.accion)}POR QUE`,
);
console.log(`  ${"-".repeat(90)}`);
for (const fila of resultados) {
  const porQue =
    fila.enRevision.length > 0 && !fila.accion.includes("tras aprobacion")
      ? `${fila.enRevision.length} campos en revision`
      : fila.detalle.slice(0, 60);
  console.log(
    `  ${fila.mensaje.padEnd(ancho.mensaje)}${`${fila.clasificacion} (${fila.regla})`.padEnd(ancho.clasificacion)}${fila.accion.padEnd(ancho.accion)}${porQue}`,
  );
}

console.log("");
console.log("El fixture no se ha tocado: todo lo escrito vive en out\\.");
console.log("La unica herramienta que escribe datos del negocio es contratos_registrar,");
console.log("y en el chat se detiene antes de ejecutarse para que una persona la apruebe.");
console.log("");
