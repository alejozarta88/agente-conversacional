import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  declarar,
  ejecutar,
  esClaseError,
  type ClaseError,
  type Registro,
} from "../tools/contrato.js";
import {
  esErrorProveedor,
  type AdaptadorProveedor,
  type Mensaje,
  type PeticionLlamada,
  type RespuestaProveedor,
} from "../llm/adapter.js";

/**
 * Ciclo del agente.
 *
 * R6: aqui NO se importa ningun proveedor concreto, solo la interfaz
 * AdaptadorProveedor. El ciclo tampoco lee variables de entorno ni toca red.
 */

export const TOPE_ITERACIONES_POR_DEFECTO = 25;
export const RUTA_LOG_POR_DEFECTO = "out/log.jsonl";
export const TOPE_MS_POR_TURNO_POR_DEFECTO = 120_000;

export interface ConfiguracionCiclo {
  /** R1. Maximo de envios al proveedor dentro de un turno. */
  readonly topeIteraciones?: number;
  /**
   * R1b. Tope de tiempo de pared de un turno, en ms. No sustituye al
   * timeout por peticion del adaptador: son dos relojes distintos.
   */
  readonly topeMsPorTurno?: number;
  /**
   * R2. Nombres de herramienta que exigen confirmacion humana. Es
   * configuracion del sistema: el modelo no decide que entra aqui.
   */
  readonly requierenConfirmacion?: readonly string[];
  /** R5. Destino del registro de llamadas. */
  readonly rutaLog?: string;
}

/**
 * Vocabulario del ciclo: que decidio la gobernanza con la llamada. Es una
 * capa distinta de ClaseError, que es el vocabulario del contrato y solo
 * habla de como fallo una herramienta que SI corrio.
 */
export type DisposicionLlamada =
  /** La llamada corrio, con o sin fallo. */
  | "ejecutada"
  /** El humano dijo que no. La herramienta NO corrio. */
  | "denegada"
  /** El turno termino esperando. La herramienta NO corrio. */
  | "pendiente";

export interface LlamadaRealizada {
  readonly id: string;
  readonly nombre: string;
  readonly argumentos: unknown;
  /** Sobre JSON: del contrato si corrio, del ciclo si no llego a correr. */
  readonly resultado: string;
  readonly ok: boolean;
  readonly disposicion: DisposicionLlamada;
  /**
   * Fallo de herramienta, tal como viene en el sobre del contrato. Solo
   * tiene valor cuando la llamada corrio y fallo: una denegada o una
   * pendiente llevan undefined, porque no hubo fallo de herramienta.
   */
  readonly clase: ClaseError | undefined;
}

/** Lo que quedo sin ejecutar esperando una decision humana. */
export interface LlamadaPendiente {
  readonly llamada: PeticionLlamada;
  /** Llamadas del mismo lote que venian detras de la pendiente. */
  readonly restantes: readonly PeticionLlamada[];
}

/** Decision humana sobre un pendiente, tomada FUERA del ciclo. */
export interface DecisionConfirmacion {
  readonly pendiente: LlamadaPendiente;
  readonly aprobada: boolean;
  readonly motivo?: string;
}

export type MotivoFin =
  | "texto"
  | "tope"
  | "tiempo"
  | "confirmacion"
  | "error-proveedor";

export interface EntradaTurno {
  readonly historial: readonly Mensaje[];
  /** "" significa que este turno no agrega mensaje de usuario. */
  readonly mensajeUsuario: string;
  readonly registro: Registro;
  readonly adaptador: AdaptadorProveedor;
  readonly configuracion?: ConfiguracionCiclo;
  /** Presente solo cuando se reanuda un turno que quedo pendiente. */
  readonly confirmacion?: DecisionConfirmacion;
}

export interface ResultadoTurno {
  readonly historial: readonly Mensaje[];
  readonly respuesta: string;
  readonly llamadas: readonly LlamadaRealizada[];
  readonly esperandoConfirmacion: LlamadaPendiente | undefined;
  readonly motivoFin: MotivoFin;
}

interface ConfiguracionResuelta {
  readonly topeIteraciones: number;
  readonly topeMsPorTurno: number;
  readonly requierenConfirmacion: ReadonlySet<string>;
  readonly rutaLog: string;
}

function resolverConfiguracion(
  configuracion: ConfiguracionCiclo | undefined,
): ConfiguracionResuelta {
  return {
    topeIteraciones:
      configuracion?.topeIteraciones ?? TOPE_ITERACIONES_POR_DEFECTO,
    topeMsPorTurno:
      configuracion?.topeMsPorTurno ?? TOPE_MS_POR_TURNO_POR_DEFECTO,
    requierenConfirmacion: new Set(configuracion?.requierenConfirmacion ?? []),
    rutaLog: configuracion?.rutaLog ?? RUTA_LOG_POR_DEFECTO,
  };
}

interface SobreLeido {
  readonly ok: boolean;
  readonly error: string;
  readonly clase: ClaseError | undefined;
  readonly data: unknown;
}

/** R5. La clase sale del sobre; aqui no se reconoce ningun texto. */
function leerSobre(salida: string): SobreLeido | undefined {
  let analizado: unknown;
  try {
    analizado = JSON.parse(salida);
  } catch {
    return undefined;
  }
  if (typeof analizado !== "object" || analizado === null) {
    return undefined;
  }
  const objeto = analizado as {
    ok?: unknown;
    error?: unknown;
    clase?: unknown;
    data?: unknown;
  };
  if (typeof objeto.ok !== "boolean") {
    return undefined;
  }
  return {
    ok: objeto.ok,
    error: typeof objeto.error === "string" ? objeto.error : "",
    clase: esClaseError(objeto.clase) ? objeto.clase : undefined,
    data: objeto.data,
  };
}

function resumir(sobre: SobreLeido): string {
  const bruto = sobre.ok ? JSON.stringify(sobre.data) : sobre.error;
  const texto = bruto ?? "null";
  return texto.length > 200 ? `${texto.slice(0, 197)}...` : texto;
}

async function anotarEnLog(
  rutaLog: string,
  llamada: LlamadaRealizada,
  sobre: SobreLeido,
): Promise<void> {
  const linea = {
    ts: new Date().toISOString(),
    herramienta: llamada.nombre,
    ok: llamada.ok,
    disposicion: llamada.disposicion,
    clase: llamada.clase ?? null,
    id: llamada.id,
    resumen: resumir(sobre),
  };
  try {
    await mkdir(dirname(rutaLog), { recursive: true });
    await appendFile(rutaLog, `${JSON.stringify(linea)}\n`, "utf8");
  } catch {
    // El log es observabilidad: si falla, no puede tumbar el turno.
  }
}

interface Contexto {
  readonly entrada: EntradaTurno;
  readonly config: ConfiguracionResuelta;
  readonly historial: Mensaje[];
  readonly llamadas: LlamadaRealizada[];
}

/** Ejecuta una llamada ya autorizada. Nunca lanza: el contrato contiene. */
async function ejecutarUna(
  ctx: Contexto,
  peticion: PeticionLlamada,
): Promise<void> {
  const salida = await ejecutar(
    ctx.entrada.registro,
    peticion.nombre,
    peticion.argumentos,
  );
  await registrarResultado(ctx, peticion, salida);
}

async function registrarResultado(
  ctx: Contexto,
  peticion: PeticionLlamada,
  salida: string,
): Promise<void> {
  const sobre = leerSobre(salida) ?? {
    ok: false,
    error: "salida ilegible del contrato",
    clase: "sobre_invalido" as const,
    data: undefined,
  };
  const llamada: LlamadaRealizada = {
    id: peticion.id,
    nombre: peticion.nombre,
    argumentos: peticion.argumentos,
    resultado: salida,
    ok: sobre.ok,
    disposicion: "ejecutada",
    clase: sobre.ok ? undefined : (sobre.clase ?? "error_herramienta"),
  };
  ctx.llamadas.push(llamada);
  // R3 y R5: el resultado vuelve al modelo tal cual, ok o no ok.
  ponerResultado(ctx, peticion, salida);
  await anotarEnLog(ctx.config.rutaLog, llamada, sobre);
}

/**
 * Deja el mensaje de herramienta de esa llamada en el historial. Si ya
 * habia uno para el mismo id — el sobre de espera que se escribio al quedar
 * pendiente — lo REEMPLAZA en su sitio, para no dejar dos respuestas al
 * mismo tool_call_id ni romper el orden.
 */
function ponerResultado(
  ctx: Contexto,
  peticion: PeticionLlamada,
  salida: string,
): void {
  const mensaje: Mensaje = {
    rol: "herramienta",
    id: peticion.id,
    nombre: peticion.nombre,
    resultado: salida,
  };
  const indice = ctx.historial.findIndex(
    (previo) => previo.rol === "herramienta" && previo.id === peticion.id,
  );
  if (indice === -1) {
    ctx.historial.push(mensaje);
    return;
  }
  ctx.historial[indice] = mensaje;
}

/**
 * Anota una llamada que NO corrio. No lleva ClaseError porque no hubo fallo
 * de herramienta: el sobre que se construye aqui es del ciclo, no del
 * contrato, y por eso sale sin clase.
 */
async function anotarNoEjecutada(
  ctx: Contexto,
  peticion: PeticionLlamada,
  disposicion: Exclude<DisposicionLlamada, "ejecutada">,
  motivo: string,
): Promise<void> {
  const salida = JSON.stringify({ ok: false, error: motivo });
  const llamada: LlamadaRealizada = {
    id: peticion.id,
    nombre: peticion.nombre,
    argumentos: peticion.argumentos,
    resultado: salida,
    ok: false,
    disposicion,
    clase: undefined,
  };
  ctx.llamadas.push(llamada);
  // INVARIANTE: todo tool_call emitido por el modelo tiene que tener su
  // mensaje de herramienta en el historial antes de la siguiente peticion,
  // tambien el que no llego a correr. Una pendiente entra con un sobre que
  // dice que espera confirmacion, y se reemplaza cuando se resuelva.
  ponerResultado(ctx, peticion, salida);
  await anotarEnLog(ctx.config.rutaLog, llamada, {
    ok: false,
    error: motivo,
    clase: undefined,
    data: undefined,
  });
}

type ResultadoLote =
  | { readonly estado: "completo" }
  | { readonly estado: "pendiente"; readonly pendiente: LlamadaPendiente };

/**
 * R2. Recorre el lote. La decision de si algo necesita confirmacion es de la
 * configuracion; la decision de si ya fue confirmada llega desde fuera en
 * forma de ids autorizados.
 */
async function ejecutarLote(
  ctx: Contexto,
  peticiones: readonly PeticionLlamada[],
  idsAutorizados: ReadonlySet<string>,
): Promise<ResultadoLote> {
  for (let i = 0; i < peticiones.length; i += 1) {
    const peticion = peticiones[i];
    if (peticion === undefined) {
      continue;
    }
    const necesita = ctx.config.requierenConfirmacion.has(peticion.nombre);
    if (necesita && !idsAutorizados.has(peticion.id)) {
      const restantes = peticiones.slice(i + 1);
      // R5: toda llamada queda registrada, tambien la que se queda
      // esperando. Y las que venian detras en el mismo lote: si se quedan
      // sin mensaje de herramienta, el historial queda invalido.
      await anotarNoEjecutada(
        ctx,
        peticion,
        "pendiente",
        `"${peticion.nombre}" espera confirmacion humana`,
      );
      for (const detras of restantes) {
        await anotarNoEjecutada(
          ctx,
          detras,
          "pendiente",
          `"${detras.nombre}" queda en espera detras de "${peticion.nombre}"`,
        );
      }
      return {
        estado: "pendiente",
        pendiente: { llamada: peticion, restantes },
      };
    }
    await ejecutarUna(ctx, peticion);
  }
  return { estado: "completo" };
}

function describirPendiente(pendiente: LlamadaPendiente): string {
  return `Espero confirmacion para ejecutar "${pendiente.llamada.nombre}" con ${JSON.stringify(pendiente.llamada.argumentos)}.`;
}

function describirErrorProveedor(
  nombreProveedor: string,
  causa: unknown,
): string {
  if (esErrorProveedor(causa)) {
    const grado = causa.recuperable ? "recuperable" : "no recuperable";
    return `El proveedor "${nombreProveedor}" fallo (${grado}, codigo ${causa.codigo}): ${causa.message}`;
  }
  if (causa instanceof Error) {
    return `El proveedor "${nombreProveedor}" fallo de forma inesperada (${causa.name}): ${causa.message}`;
  }
  return `El proveedor "${nombreProveedor}" fallo de forma inesperada: ${String(causa)}`;
}

export async function ejecutarTurno(
  entrada: EntradaTurno,
): Promise<ResultadoTurno> {
  const config = resolverConfiguracion(entrada.configuracion);
  const ctx: Contexto = {
    entrada,
    config,
    historial: [...entrada.historial],
    llamadas: [],
  };

  if (entrada.mensajeUsuario !== "") {
    ctx.historial.push({ rol: "usuario", texto: entrada.mensajeUsuario });
  }

  const declaraciones = declarar(entrada.registro);

  // Reanudacion de un turno que habia quedado esperando confirmacion.
  if (entrada.confirmacion !== undefined) {
    const reanudacion = await reanudar(ctx, entrada.confirmacion);
    if (reanudacion.estado === "pendiente") {
      return finPorConfirmacion(ctx, "", reanudacion.pendiente);
    }
  }

  let ultimoTexto = "";
  const arranque = Date.now();
  const sinTiempo = (): boolean =>
    Date.now() - arranque >= config.topeMsPorTurno;

  // R1. El tope cuenta envios al proveedor dentro de este turno.
  for (
    let iteracion = 1;
    iteracion <= config.topeIteraciones;
    iteracion += 1
  ) {
    // R1b. El reloj se mira antes de gastar otra peticion al proveedor.
    if (sinTiempo()) {
      return finPorTiempo(ctx, config, ultimoTexto);
    }

    let respuesta: RespuestaProveedor;
    try {
      respuesta = await entrada.adaptador.enviar(ctx.historial, declaraciones);
    } catch (causa: unknown) {
      // R4.
      const mensaje = describirErrorProveedor(entrada.adaptador.nombre, causa);
      ctx.historial.push({ rol: "asistente", texto: mensaje });
      return {
        historial: ctx.historial,
        respuesta: mensaje,
        llamadas: ctx.llamadas,
        esperandoConfirmacion: undefined,
        motivoFin: "error-proveedor",
      };
    }

    if (respuesta.tipo === "texto") {
      ctx.historial.push({ rol: "asistente", texto: respuesta.texto });
      return {
        historial: ctx.historial,
        respuesta: respuesta.texto,
        llamadas: ctx.llamadas,
        esperandoConfirmacion: undefined,
        motivoFin: "texto",
      };
    }

    if (respuesta.texto !== "") {
      ultimoTexto = respuesta.texto;
    }

    // R5. La peticion de llamadas queda anotada en el historial.
    ctx.historial.push({
      rol: "asistente",
      texto: respuesta.texto,
      llamadas: respuesta.llamadas,
    });

    const lote = await ejecutarLote(ctx, respuesta.llamadas, new Set());
    if (lote.estado === "pendiente") {
      return finPorConfirmacion(ctx, ultimoTexto, lote.pendiente);
    }

    // Y tambien despues de ejecutar, que es donde se va el tiempo.
    if (sinTiempo()) {
      return finPorTiempo(ctx, config, ultimoTexto);
    }
  }

  // R1. Se alcanzo el tope: no se lanza, se responde con lo que hay.
  const aviso =
    `${ultimoTexto === "" ? "" : `${ultimoTexto}\n\n`}` +
    `Alcance el tope de ${config.topeIteraciones} iteraciones en este turno y lo corto aqui.`;
  ctx.historial.push({ rol: "asistente", texto: aviso });
  return {
    historial: ctx.historial,
    respuesta: aviso,
    llamadas: ctx.llamadas,
    esperandoConfirmacion: undefined,
    motivoFin: "tope",
  };
}

/**
 * R1b. Se agoto el tiempo del turno: como el tope de iteraciones, no lanza;
 * responde con lo que hay y lo declara.
 */
function finPorTiempo(
  ctx: Contexto,
  config: ConfiguracionResuelta,
  ultimoTexto: string,
): ResultadoTurno {
  const aviso =
    `${ultimoTexto === "" ? "" : `${ultimoTexto}

`}` +
    `Se agoto el tiempo de este turno (${config.topeMsPorTurno} ms) y lo corto aqui.`;
  ctx.historial.push({ rol: "asistente", texto: aviso });
  return {
    historial: ctx.historial,
    respuesta: aviso,
    llamadas: ctx.llamadas,
    esperandoConfirmacion: undefined,
    motivoFin: "tiempo",
  };
}

function finPorConfirmacion(
  ctx: Contexto,
  textoPrevio: string,
  pendiente: LlamadaPendiente,
): ResultadoTurno {
  const respuesta =
    `${textoPrevio === "" ? "" : `${textoPrevio}\n\n`}` +
    describirPendiente(pendiente);
  ctx.historial.push({ rol: "asistente", texto: respuesta });
  return {
    historial: ctx.historial,
    respuesta,
    llamadas: ctx.llamadas,
    esperandoConfirmacion: pendiente,
    motivoFin: "confirmacion",
  };
}

/**
 * Aplica la decision humana al pendiente y sigue con lo que venia detras.
 * Aprobar no es ejecutar: la aprobacion solo autoriza ese id concreto.
 */
async function reanudar(
  ctx: Contexto,
  decision: DecisionConfirmacion,
): Promise<ResultadoLote> {
  const { llamada, restantes } = decision.pendiente;

  if (!decision.aprobada) {
    const motivo = decision.motivo ?? "sin motivo";
    await anotarNoEjecutada(
      ctx,
      llamada,
      "denegada",
      `confirmacion denegada para "${llamada.nombre}": ${motivo}`,
    );
    return ejecutarLote(ctx, restantes, new Set());
  }

  return ejecutarLote(ctx, [llamada, ...restantes], new Set([llamada.id]));
}

