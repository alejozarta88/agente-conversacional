import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { AdaptadorOpenAI } from "./llm/openai.js";
import { crearServidor } from "./server.js";
import { combinar, registrar } from "./tools/contrato.js";
import { borrar, eco, fallar } from "./tools/laboratorio.js";

/**
 * Arranque local. Es el UNICO sitio que construye el adaptador real: el
 * servidor recibe el proveedor por inyeccion y no sabe de donde sale.
 *
 * La clave llega por OPENAI_API_KEY, que Node carga de .env con el flag
 * --env-file-if-exists del script de package.json. Aqui no se lee ningun
 * fichero de configuracion.
 */

const PUERTO = Number(process.env["PUERTO"] ?? 3000);

/**
 * El PRD pide que out\ se limpie al iniciar. Se vacia el CONTENIDO del
 * directorio, no el directorio en si, y solo ese: la ruta se resuelve desde
 * el directorio de trabajo, que es el mismo contra el que el ciclo escribe
 * su out\log.jsonl. Nada fuera de out\ se toca.
 */
async function limpiarOut(): Promise<void> {
  const directorio = resolve(process.cwd(), "out");
  await mkdir(directorio, { recursive: true });
  const entradas = await readdir(directorio);
  for (const entrada of entradas) {
    await rm(join(directorio, entrada), { recursive: true, force: true });
  }
  console.log(
    entradas.length === 0
      ? `Directorio de salida limpio: ${directorio}`
      : `Directorio de salida limpiado: ${directorio} (${entradas.length} entrada(s) borrada(s): ${entradas.join(", ")})`,
  );
}

await limpiarOut();

const registro = combinar(
  registrar("laboratorio.ts", { eco, fallar, borrar }),
);

const adaptador = new AdaptadorOpenAI();

const servidor = crearServidor({
  adaptador,
  registro,
  configuracionCiclo: {
    topeIteraciones: 25,
    requierenConfirmacion: ["laboratorio_borrar"],
  },
});

servidor.listen(PUERTO, "127.0.0.1", () => {
  console.log(`Agente escuchando en http://127.0.0.1:${PUERTO}`);
  console.log(`Modelo: ${adaptador.config.modelo}`);
});
