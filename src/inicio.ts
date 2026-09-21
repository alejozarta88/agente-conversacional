import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AdaptadorOpenAI } from "./llm/openai.js";
import {
  EXIGEN_APROBACION,
  REGISTRO_AGENTE,
  TOPE_ITERACIONES,
} from "./registro.js";
import { crearServidor } from "./server.js";

/**
 * Arranque local. Es el UNICO sitio que construye el adaptador real: el
 * servidor recibe el proveedor por inyeccion y no sabe de donde sale.
 *
 * La clave llega por OPENAI_API_KEY, que Node carga de .env con el flag
 * --env-file-if-exists del script de package.json. Aqui no se lee ningun
 * fichero de configuracion.
 */

/**
 * Puerto, por orden de precedencia: PORT (la que inyectan los servicios de
 * despliegue) > PUERTO (la nuestra, comoda en local) > 3000.
 * Bind, por orden de precedencia: HOST > 127.0.0.1. Solo loopback por
 * defecto: para exponerlo, como dentro de un contenedor, hay que pedirlo
 * explicitamente con HOST=0.0.0.0.
 */
const PUERTO = Number(
  process.env["PORT"] ?? process.env["PUERTO"] ?? 3000,
);
const HOST = process.env["HOST"] ?? "127.0.0.1";

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

/**
 * Comprobacion de arranque: los archivos de DATOS que el agente necesita
 * para poder trabajar.
 *
 * Existe porque un despliegue estaba roto de forma invisible. El
 * Dockerfile no copiaba fixtures\ ni la capa de conocimiento, y nada
 * fallaba: leer_buzon devolvia {total: 0} porque existsSync daba false,
 * alertas leia un maestro vacio, y el servidor arrancaba sin las reglas
 * del proceso tras un console.error que nadie mira. El contenedor
 * respondia 200 y no podia hacer su trabajo.
 *
 * Un despliegue que responde 200 y no puede trabajar es peor que uno que
 * no arranca: el primero se descubre en la demo, el segundo en el
 * despliegue. Asi que esto sale con codigo distinto de cero.
 *
 * Vive aqui y no en server.ts a proposito: server.ts es una pieza
 * reutilizable a la que se le inyectan las rutas, e inicio.ts es el unico
 * sitio que sabe como esta montado el despliegue real.
 */
function comprobarDatos(): void {
  // Dos raices distintas, porque se resuelven distinto y mezclarlas seria
  // comprobar algo que nadie lee:
  //   - prompt, conocimiento y web: relativos al MODULO (import.meta.url),
  //     que es como los resuelve server.ts.
  //   - fixtures: relativos al DIRECTORIO DE TRABAJO, que es como los
  //     resuelve tools/contratos.ts.
  const raizModulo = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const raizTrabajo = resolve(process.cwd());
  const faltan: string[] = [];

  const exigirArchivo = (
    base: string,
    relativa: string,
    para: string,
  ): void => {
    const ruta = join(base, relativa);
    if (!existsSync(ruta) || !statSync(ruta).isFile()) {
      faltan.push(`${ruta}  (${para})`);
    }
  };

  exigirArchivo(raizModulo, "modulo/agent.md", "comportamiento del agente");
  exigirArchivo(
    raizModulo,
    "modulo/skill/registro-contratos/SKILL.md",
    "capa de conocimiento: reglas RN1-RN7",
  );
  exigirArchivo(
    raizModulo,
    "modulo/tools/contratos.ts",
    "modulo reutilizable: reexportacion de las herramientas",
  );
  exigirArchivo(raizModulo, "web/index.html", "interfaz de chat");
  exigirArchivo(
    raizTrabajo,
    "fixtures/reto-02/maestro-contratos.csv",
    "maestro de contratos",
  );
  exigirArchivo(
    raizTrabajo,
    "fixtures/reto-02/comerciales.json",
    "directorio de comerciales",
  );

  const buzon = join(raizTrabajo, "fixtures/reto-02/buzon");
  if (!existsSync(buzon) || !statSync(buzon).isDirectory()) {
    faltan.push(`${buzon}  (buzon de mensajes)`);
  } else {
    const mensajes = readdirSync(buzon, { withFileTypes: true }).filter(
      (entrada) => entrada.isDirectory(),
    );
    if (mensajes.length === 0) {
      faltan.push(
        `${buzon}  (existe pero esta vacio: sin mensajes no hay nada que procesar)`,
      );
    } else {
      console.log(
        `Datos: buzon con ${mensajes.length} mensajes (${mensajes.map((entrada) => entrada.name).join(", ")})`,
      );
    }
  }

  if (faltan.length > 0) {
    console.error("");
    console.error("ARRANQUE ABORTADO: faltan archivos de datos.");
    console.error(`Raiz del modulo:        ${raizModulo}`);
    console.error(`Directorio de trabajo:  ${raizTrabajo}`);
    console.error("");
    for (const falta of faltan) {
      console.error(`  FALTA  ${falta}`);
    }
    console.error("");
    console.error(
      "El agente arrancaria y responderia 200 sin poder trabajar, asi que no",
    );
    console.error(
      "arranca. Si esto es una imagen, revisa los COPY del Dockerfile.",
    );
    console.error("");
    process.exit(1);
  }

  console.log("Datos: prompt, conocimiento, web y fixtures presentes.");
}

comprobarDatos();

await limpiarOut();

const adaptador = new AdaptadorOpenAI();

const servidor = crearServidor({
  adaptador,
  registro: REGISTRO_AGENTE,
  configuracionCiclo: {
    topeIteraciones: TOPE_ITERACIONES,
    requierenConfirmacion: EXIGEN_APROBACION,
  },
});

servidor.listen(PUERTO, HOST, () => {
  console.log(`Agente escuchando en http://${HOST}:${PUERTO}`);
  console.log(`Modelo: ${adaptador.config.modelo}`);
});
