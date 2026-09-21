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
  /**
   * Tope de tokens por SESION. Requisito no funcional: "un usuario no
   * puede gastar tu clave sin limite". 0 o ausente = sin tope.
   *
   * Se comprueba antes de cada envio al proveedor, no solo al empezar el
   * turno: el historial completo se reenvia en cada iteracion, asi que un
   * turno largo puede gastar mucho mas que el mensaje que lo inicio.
   */
  readonly topeTokensSesion?: number;
  /** Lo que la sesion ya gasto en turnos anteriores. Lo lleva el servidor. */
  readonly tokensGastadosAntes?: number;
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

/**
 * Por que una llamada NO corrio, en el sobre que ve el modelo.
 *
 * Existe porque las tres situaciones producian el mismo sobre
 * —{ok:false, error:"<prosa>"}— y solo se distinguian leyendo el texto. Un
 * modelo leyo "queda en espera detras de X" y lo reporto como denegada:
 * afirmo el resultado de una llamada que nunca corrio. La prosa era lo que
 * fallaba, asi que el arreglo es un campo cerrado, no una redaccion mejor.
 *
 * `disposicion` ya existia, pero es vocabulario del ciclo y viaja al log y
 * al front: nunca llegaba al modelo.
 */
export type EstadoNoEjecutada =
  /** Retenida: una persona tiene que aprobarla o denegarla. Sin decision. */
  | "espera_aprobacion"
  /** El turno acabo antes de llegar a ella. Nadie decidio nada sobre esta. */
  | "no_alcanzada"
  /** Una persona dijo que no, explicitamente. */
  | "denegada";

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
  | "tope-tokens"
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
  /** Tokens que consumio ESTE turno. El servidor los acumula por sesion. */
  readonly tokensUsados: number;
}

interface ConfiguracionResuelta {
  readonly topeIteraciones: number;
  readonly topeMsPorTurno: number;
  readonly requierenConfirmacion: ReadonlySet<string>;
  readonly rutaLog: string;
  readonly topeTokensSesion: number;
  readonly tokensGastadosAntes: number;
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
    topeTokensSesion: configuracion?.topeTokensSesion ?? 0,
    tokensGastadosAntes: configuracion?.tokensGastadosAntes ?? 0,
  };
}

/**
 * De donde sale el conteo de tokens, por orden de preferencia:
 *
 * 1. `uso.total` que devuelve el proveedor. Es el numero que se factura,
 *    asi que cuando viene manda ese.
 * 2. Si el proveedor no lo reporta —el falso de las pruebas, o una
 *    respuesta recortada—, se ESTIMA a razon de 4 caracteres por token
 *    sobre lo enviado mas lo recibido. Es una aproximacion conocida y
 *    conservadora para texto latino; sirve para que el tope siga
 *    aplicando cuando no hay dato real, no para facturar.
 */
const CARACTERES_POR_TOKEN = 4;

function estimarTokens(
  mensajes: readonly Mensaje[],
  respuesta: RespuestaProveedor,
): number {
  let caracteres = 0;
  for (const mensaje of mensajes) {
    // Un mensaje de herramienta no lleva `texto` sino `resultado`.
    caracteres +=
      mensaje.rol === "herramienta"
        ? mensaje.nombre.length + mensaje.resultado.length
        : mensaje.texto.length;
  }
  caracteres += respuesta.texto.length;
  if (respuesta.tipo === "llamadas") {
    for (const llamada of respuesta.llamadas) {
      caracteres +=
        llamada.nombre.length + JSON.stringify(llamada.argumentos).length;
    }
  }
  return Math.ceil(caracteres / CARACTERES_POR_TOKEN);
}

function tokensDe(
  mensajes: readonly Mensaje[],
  respuesta: RespuestaProveedor,
): number {
  return respuesta.uso?.total ?? estimarTokens(mensajes, respuesta);
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

/**
 * RN7 pide mensaje_id en cada linea del log. El ciclo no sabe de
 * contratos, asi que lo lee de los argumentos de forma generica: si la
 * llamada trae un `mensaje_id` de tipo string, ese; si no, null.
 *
 * Va siempre, con valor null cuando no aplica. Un campo ausente obliga a
 * quien lee el log a distinguir "no habia mensaje" de "se me olvido
 * escribirlo"; un null explicito no.
 */
function mensajeIdDe(argumentos: unknown): string | null {
  if (typeof argumentos !== "object" || argumentos === null) {
    return null;
  }
  const valor = (argumentos as { mensaje_id?: unknown }).mensaje_id;
  return typeof valor === "string" ? valor : null;
}

async function anotarEnLog(
  rutaLog: string,
  llamada: LlamadaRealizada,
  sobre: SobreLeido,
): Promise<void> {
  const linea = {
    ts: new Date().toISOString(),
    herramienta: llamada.nombre,
    mensaje_id: mensajeIdDe(llamada.argumentos),
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
  /** Tokens consumidos en este turno, acumulados envio a envio. */
  tokensUsados: number;
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
/**
 * El sobre de una llamada que no corrio. Lleva DOS campos cerrados que el
 * modelo puede mirar sin interpretar prosa:
 *
 *   ejecutada: false   -> no corrio, punto.
 *   estado: <cerrado>  -> por que no corrio.
 *
 * `ok` sigue en false porque no hubo exito, pero por si solo no bastaba:
 * un modelo que ve ok:false concluye "fallo", y una llamada en cola no
 * fallo, simplemente no se llego a ella.
 */
function sobreNoEjecutada(estado: EstadoNoEjecutada, motivo: string): string {
  return JSON.stringify({
    ok: false,
    ejecutada: false,
    estado,
    error: motivo,
  });
}

async function anotarNoEjecutada(
  ctx: Contexto,
  peticion: PeticionLlamada,
  disposicion: Exclude<DisposicionLlamada, "ejecutada">,
  estado: EstadoNoEjecutada,
  motivo: string,
): Promise<void> {
  const salida = sobreNoEjecutada(estado, motivo);
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
        "espera_aprobacion",
        `"${peticion.nombre}" NO se ha ejecutado. Esta retenida a la espera de que una persona la apruebe o la deniegue. Todavia no hay decision: no es una denegacion ni un fallo.`,
      );
      for (const detras of restantes) {
        await anotarNoEjecutada(
          ctx,
          detras,
          "pendiente",
          "no_alcanzada",
          `"${detras.nombre}" NO se ha ejecutado. El turno termino antes de llegar a ella, porque una llamada anterior del mismo lote quedo retenida. Nadie la ha denegado, no ha fallado, y no se ha tomado ninguna decision sobre ella. Queda por hacer.`,
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

/** Un argumento aplanado: su ruta y su valor, listos para pintar. */
export interface CampoArgumento {
  readonly campo: string;
  readonly valor: string;
}

/**
 * Exportada a proposito: el servidor la usa para mandarle al front los
 * mismos campos ya aplanados. Hubo un fallo por tener dos renderizadores,
 * el texto del agente en prosa y el bloque destacado volcando JSON. Una
 * sola fuente de verdad.
 */
export function camposDeArgumentos(
  valor: unknown,
  prefijo = "",
): readonly CampoArgumento[] {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    return [{ campo: prefijo, valor: JSON.stringify(valor) ?? "null" }];
  }
  const salida: CampoArgumento[] = [];
  for (const [clave, anidado] of Object.entries(valor)) {
    const ruta = prefijo === "" ? clave : `${prefijo}.${clave}`;
    salida.push(...camposDeArgumentos(anidado, ruta));
  }
  return salida;
}

/**
 * El bloque que la persona lee antes de aprobar. Va campo a campo, en
 * prosa, y NO como volcado JSON.
 *
 * El motivo esta en S-22: lo que se aprueba son estos argumentos exactos,
 * asi que el humano tiene que poder leer "fecha_fin: 2027-08-31" de un
 * vistazo y no buscar el dato dentro de una linea de JSON, donde un
 * digito cambiado pasa desapercibido. Los objetos anidados se aplanan con
 * la ruta del campo por el mismo motivo.
 */
function describirPendiente(pendiente: LlamadaPendiente): string {
  const campos = camposDeArgumentos(pendiente.llamada.argumentos);
  const cuerpo =
    campos.length === 0
      ? "  (sin argumentos)"
      : campos.map(({ campo, valor }) => `  ${campo}: ${valor}`).join("\n");
  return [
    `Voy a ejecutar "${pendiente.llamada.nombre}" con estos datos:`,
    "",
    cuerpo,
    "",
    "Revisa los valores antes de aprobar: es exactamente esto lo que se ejecutara.",
  ].join("\n");
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
    tokensUsados: 0,
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

    // Tope de gasto. Se mira ANTES de cada envio y no solo al empezar el
    // turno: el historial entero viaja en cada iteracion, asi que un turno
    // de 25 iteraciones cuesta mucho mas que el mensaje que lo inicio.
    if (sinPresupuesto(ctx)) {
      return finPorTokens(ctx, ultimoTexto);
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
        tokensUsados: ctx.tokensUsados,
      };
    }

    ctx.tokensUsados += tokensDe(ctx.historial, respuesta);

    if (respuesta.tipo === "texto") {
      ctx.historial.push({ rol: "asistente", texto: respuesta.texto });
      return {
        historial: ctx.historial,
        respuesta: respuesta.texto,
        llamadas: ctx.llamadas,
        esperandoConfirmacion: undefined,
        motivoFin: "texto",
        tokensUsados: ctx.tokensUsados,
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
    tokensUsados: ctx.tokensUsados,
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
    tokensUsados: ctx.tokensUsados,
  };
}

/** Presupuesto agotado para esta sesion. 0 significa sin tope. */
function sinPresupuesto(ctx: Contexto): boolean {
  const tope = ctx.config.topeTokensSesion;
  if (tope <= 0) {
    return false;
  }
  return ctx.config.tokensGastadosAntes + ctx.tokensUsados >= tope;
}

function finPorTokens(ctx: Contexto, textoPrevio: string): ResultadoTurno {
  const gastado = ctx.config.tokensGastadosAntes + ctx.tokensUsados;
  const aviso =
    `Esta conversacion ha alcanzado su tope de ${ctx.config.topeTokensSesion} tokens ` +
    `(llevas ${gastado}). Abre una conversacion nueva para seguir.`;
  const respuesta = textoPrevio === "" ? aviso : `${textoPrevio}

${aviso}`;
  ctx.historial.push({ rol: "asistente", texto: respuesta });
  return {
    historial: ctx.historial,
    respuesta,
    llamadas: ctx.llamadas,
    esperandoConfirmacion: undefined,
    motivoFin: "tope-tokens",
    tokensUsados: ctx.tokensUsados,
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
    tokensUsados: ctx.tokensUsados,
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
      "denegada",
      `"${llamada.nombre}" NO se ejecuto: una persona la denego de forma explicita. Motivo: ${motivo}. Esta decision vale SOLO para esta llamada.`,
    );
    return ejecutarLote(ctx, restantes, new Set());
  }

  return ejecutarLote(ctx, [llamada, ...restantes], new Set([llamada.id]));
}

