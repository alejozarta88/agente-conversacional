import { combinar, declarar, ejecutar, registrar } from "./src/tools/contrato.js";
import * as ejemplo from "./src/tools/ejemplo.js";
import {
  borrar,
  eco,
  efectos,
  explotarAsync,
  fallar,
  malEscrita,
} from "./src/tools/laboratorio.js";

/**
 * Demo sin clave, sin red y sin servidor: llama a las herramientas que
 * existen hoy a traves del contrato e imprime el sobre de cada una.
 */

const registro = combinar(
  registrar("ejemplo.ts", ejemplo),
  registrar("laboratorio.ts", {
    eco,
    fallar,
    explotarAsync,
    borrar,
    malEscrita,
  }),
);

interface Caso {
  readonly nombre: string;
  readonly argumentos: unknown;
  readonly comentario: string;
}

const casos: readonly Caso[] = [
  { nombre: "ejemplo_sumar", argumentos: { a: 2, b: 40 }, comentario: "suma normal" },
  {
    nombre: "ejemplo_sumar",
    argumentos: { a: "dos", b: 40 },
    comentario: "argumentos invalidos",
  },
  {
    nombre: "ejemplo_explotar",
    argumentos: { motivo: "demo" },
    comentario: "excepcion contenida",
  },
  {
    nombre: "laboratorio_eco",
    argumentos: { texto: "hola mundo" },
    comentario: "eco en mayusculas",
  },
  {
    nombre: "laboratorio_fallar",
    argumentos: { causa: "disco lleno" },
    comentario: "error legitimo de herramienta",
  },
  {
    nombre: "laboratorio_explotarAsync",
    argumentos: { motivo: "demo" },
    comentario: "promesa rechazada",
  },
  {
    nombre: "laboratorio_borrar",
    argumentos: { recurso: "informe" },
    comentario: "efecto real (aqui sin la guardia del ciclo)",
  },
  {
    nombre: "laboratorio_malEscrita",
    argumentos: { entrada: "lo que sea" },
    comentario: "sobre invalido",
  },
  {
    nombre: "laboratorio_inexistente",
    argumentos: {},
    comentario: "herramienta desconocida",
  },
];

console.log("Herramientas declaradas para el modelo:");
for (const declaracion of declarar(registro)) {
  console.log(`  - ${declaracion.name}: ${declaracion.description}`);
}
console.log("");

for (const [indice, caso] of casos.entries()) {
  const salida = await ejecutar(registro, caso.nombre, caso.argumentos);
  console.log(`${indice + 1}. ${caso.nombre}  (${caso.comentario})`);
  console.log(`   argumentos: ${JSON.stringify(caso.argumentos)}`);
  console.log(`   sobre:      ${salida}`);
}

console.log("");
console.log(`Efectos acumulados: borrados=[${efectos.borrados.join(", ")}]`);
console.log(
  "Nota: la guardia de confirmacion vive en el ciclo, no en el contrato:",
);
console.log(
  "por eso laboratorio_borrar se ejecuta aqui y en el chat pide confirmacion.",
);
