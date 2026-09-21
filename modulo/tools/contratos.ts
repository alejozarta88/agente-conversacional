/**
 * Las cinco herramientas del dominio, importables sin el servidor y sin
 * modelo.
 *
 * ESTE ARCHIVO NO TIENE CONTENIDO PROPIO. Es una reexportacion de
 * `src/tools/contratos.ts`, que es la definicion unica. Lo que usa la
 * aplicacion y lo que usa quien importe el modulo son el mismo codigo, no
 * dos copias: **no puede divergir porque no hay nada de que divergir**.
 *
 * Por que una reexportacion y no mover el original aqui: mover el archivo
 * obligaria a cambiar `rootDir` en tsconfig.build.json y la ruta del CMD
 * del Dockerfile, sin ganar nada. Los dos Markdown del modulo si son los
 * originales —`modulo/agent.md` y `modulo/skill/registro-contratos/SKILL.md`—
 * porque un Markdown no se puede reexportar y ahi la unica forma de
 * garantizar que no divergen es que exista un solo archivo. Ver SOLUCION.md.
 *
 * Uso desde fuera, sin servidor y sin clave:
 *
 *     import { leer_buzon, extraer } from "./modulo/tools/contratos.js";
 *     const sobre = await leer_buzon.validarYEjecutar({});
 *
 * Cada herramienta es una `HerramientaPreparada`: `validarYEjecutar` valida
 * los argumentos con zod y devuelve el sobre JSON del contrato. No hace
 * falta registro, ni ciclo, ni proveedor.
 *
 * LIMITACION CONOCIDA: las herramientas resuelven las rutas de datos contra
 * el directorio de trabajo del proceso, asi que quien importe el modulo
 * tiene que correr desde una raiz que contenga `fixtures/reto-02/`. Es el
 * mismo hueco que §11.1 de SOLUCION.md: el `ctx { directory, sessionId }`
 * que declara el PRD en 6.2 y que no esta implementado.
 */
export {
  leer_buzon,
  extraer,
  validar,
  registrar,
  alertas,
} from "../../src/tools/contratos.js";

export type {
  Campo,
  Clasificacion,
  Diferencia,
  Extraccion,
  NombreCampo,
  Validacion,
  ResultadoRegistro,
  Alertas,
} from "../../src/tools/contratos.js";
