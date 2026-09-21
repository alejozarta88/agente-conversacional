import type { DeclaracionHerramienta } from "../tools/contrato.js";

/**
 * Interfaz del adaptador de proveedor. SOLO tipos: aqui no hay red, ni
 * claves, ni ninguna implementacion concreta.
 */

/** Peticion de llamada a herramienta tal como la pide el modelo. */
export interface PeticionLlamada {
  /** Identificador de la llamada, para casar peticion y resultado. */
  readonly id: string;
  /** Nombre en formato <archivo>_<export>. */
  readonly nombre: string;
  /** Argumentos SIN validar: el contrato los valida. */
  readonly argumentos: unknown;
}

/** Instrucciones de sistema. Van primeras y no las escribe la persona. */
export interface MensajeSistema {
  readonly rol: "sistema";
  readonly texto: string;
}

export interface MensajeUsuario {
  readonly rol: "usuario";
  readonly texto: string;
}

export interface MensajeAsistente {
  readonly rol: "asistente";
  readonly texto: string;
  /** Ausente o vacia = respuesta final sin herramientas. */
  readonly llamadas?: readonly PeticionLlamada[];
}

/** Resultado de herramienta que vuelve al modelo. Siempre el sobre JSON. */
export interface MensajeHerramienta {
  readonly rol: "herramienta";
  readonly id: string;
  readonly nombre: string;
  /** String JSON del contrato: {"ok":true,...} o {"ok":false,...}. */
  readonly resultado: string;
}

export type Mensaje =
  | MensajeSistema
  | MensajeUsuario
  | MensajeAsistente
  | MensajeHerramienta;

/**
 * Consumo declarado por el proveedor. Es el numero que se factura, asi
 * que cuando viene se usa este y no una estimacion nuestra.
 */
export interface UsoTokens {
  readonly entrada: number;
  readonly salida: number;
  readonly total: number;
}

/** Las dos cosas distintas que puede expresar una respuesta del proveedor. */
export type RespuestaProveedor =
  | {
      readonly tipo: "texto";
      readonly texto: string;
      /** Ausente si el proveedor no lo reporta; entonces se estima. */
      readonly uso?: UsoTokens;
    }
  | {
      readonly tipo: "llamadas";
      /** Texto que acompana a las llamadas; puede ser "". */
      readonly texto: string;
      readonly llamadas: readonly PeticionLlamada[];
      readonly uso?: UsoTokens;
    };

/**
 * Error del proveedor. Distingue recuperable (merece reintento) de no
 * recuperable (no lo merece). La logica de reintento NO vive aqui.
 */
export class ErrorProveedor extends Error {
  readonly recuperable: boolean;
  readonly codigo: string;

  constructor(
    mensaje: string,
    opciones: { recuperable: boolean; codigo?: string; causa?: unknown },
  ) {
    super(mensaje, opciones.causa === undefined ? {} : { cause: opciones.causa });
    this.name = "ErrorProveedor";
    this.recuperable = opciones.recuperable;
    this.codigo = opciones.codigo ?? "desconocido";
  }
}

export function esErrorProveedor(causa: unknown): causa is ErrorProveedor {
  return causa instanceof ErrorProveedor;
}

/** Lo unico que el ciclo conoce de un proveedor. */
export interface AdaptadorProveedor {
  /** Nombre legible, solo para registro y mensajes de error. */
  readonly nombre: string;
  enviar(
    mensajes: readonly Mensaje[],
    herramientas: readonly DeclaracionHerramienta[],
  ): Promise<RespuestaProveedor>;
}
