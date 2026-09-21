import { setTimeout as dormir } from "node:timers/promises";

import type { DeclaracionHerramienta } from "../tools/contrato.js";
import {
  ErrorProveedor,
  type AdaptadorProveedor,
  type Mensaje,
  type PeticionLlamada,
  type RespuestaProveedor,
} from "./adapter.js";

/**
 * Adaptador real de OpenAI sobre fetch nativo. Sin SDK y sin cliente HTTP.
 *
 * La clave se lee de OPENAI_API_KEY al construir y no sale de aqui: no se
 * escribe en logs, ni en mensajes de error, ni en el objeto devuelto.
 */

export const URL_BASE_POR_DEFECTO = "https://api.openai.com/v1";
export const MODELO_POR_DEFECTO = "gpt-5.4-mini";
export const TIMEOUT_MS_POR_DEFECTO = 60_000;
export const INTENTOS_POR_DEFECTO = 3;
export const ESPERA_INICIAL_MS_POR_DEFECTO = 1_000;
export const FACTOR_ESPERA_POR_DEFECTO = 2;
export const ESPERA_MAXIMA_MS_POR_DEFECTO = 30_000;

export interface OpcionesOpenAI {
  /** Configurable para poder apuntar a un servidor local en las pruebas. */
  readonly urlBase?: string;
  readonly modelo?: string;
  readonly timeoutMs?: number;
  /** Numero total de intentos, no de reintentos. */
  readonly intentos?: number;
  readonly esperaInicialMs?: number;
  readonly factorEspera?: number;
  readonly esperaMaximaMs?: number;
}

interface ConfiguracionOpenAI {
  readonly urlBase: string;
  readonly modelo: string;
  readonly timeoutMs: number;
  readonly intentos: number;
  readonly esperaInicialMs: number;
  readonly factorEspera: number;
  readonly esperaMaximaMs: number;
}

/**
 * UNICO sitio donde se decide recuperable contra no recuperable.
 * 429 y 5xx recuperables; 400, 401, 403, 404 y el resto de 4xx no.
 */
export function esEstadoRecuperable(estado: number): boolean {
  if (estado === 429) {
    return true;
  }
  return estado >= 500;
}

function codigoDeEstado(estado: number): string {
  return `http_${estado}`;
}

function leerObjeto(valor: unknown): Record<string, unknown> | undefined {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    return undefined;
  }
  return valor as Record<string, unknown>;
}

function leerTexto(valor: unknown): string | undefined {
  return typeof valor === "string" ? valor : undefined;
}

function recortar(texto: string, limite = 300): string {
  return texto.length > limite ? `${texto.slice(0, limite - 3)}...` : texto;
}

/** Espera indicada por el servidor, en ms. undefined si no viene. */
function esperaDeCabecera(cabeceras: Headers): number | undefined {
  const enMs = cabeceras.get("retry-after-ms");
  if (enMs !== null) {
    const valor = Number(enMs);
    if (Number.isFinite(valor) && valor >= 0) {
      return valor;
    }
  }
  const enSegundos = cabeceras.get("retry-after");
  if (enSegundos !== null) {
    const valor = Number(enSegundos);
    if (Number.isFinite(valor) && valor >= 0) {
      return valor * 1000;
    }
  }
  return undefined;
}

interface MensajeOpenAI {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
  readonly tool_call_id?: string;
}

function haciaOpenAI(mensajes: readonly Mensaje[]): MensajeOpenAI[] {
  return mensajes.map((mensaje): MensajeOpenAI => {
    if (mensaje.rol === "sistema") {
      return { role: "system", content: mensaje.texto };
    }
    if (mensaje.rol === "usuario") {
      return { role: "user", content: mensaje.texto };
    }
    if (mensaje.rol === "herramienta") {
      return {
        role: "tool",
        content: mensaje.resultado,
        tool_call_id: mensaje.id,
      };
    }
    const llamadas = mensaje.llamadas ?? [];
    if (llamadas.length === 0) {
      return { role: "assistant", content: mensaje.texto };
    }
    return {
      role: "assistant",
      content: mensaje.texto === "" ? null : mensaje.texto,
      tool_calls: llamadas.map((llamada) => ({
        id: llamada.id,
        type: "function",
        function: {
          name: llamada.nombre,
          arguments: JSON.stringify(llamada.argumentos ?? {}),
        },
      })),
    };
  });
}

interface HerramientaOpenAI {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: DeclaracionHerramienta["input_schema"];
  };
}

/** Las declaraciones salen de declarar(); aqui solo se cambia el envoltorio. */
function herramientasHaciaOpenAI(
  declaraciones: readonly DeclaracionHerramienta[],
): HerramientaOpenAI[] {
  return declaraciones.map((declaracion) => ({
    type: "function",
    function: {
      name: declaracion.name,
      description: declaracion.description,
      parameters: declaracion.input_schema,
    },
  }));
}

/**
 * Argumentos malformados: NO se rompe el turno. La peticion viaja con el
 * string crudo y el contrato la rechaza con argumentos_invalidos, que el
 * ciclo devuelve al modelo para que se corrija. Un reintento HTTP no
 * arreglaria un error de redaccion del modelo.
 */
function argumentosDeLlamada(crudos: string): unknown {
  if (crudos.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(crudos);
  } catch {
    return crudos;
  }
}

function desdeOpenAI(cuerpo: unknown): RespuestaProveedor {
  const raiz = leerObjeto(cuerpo);
  const opciones = raiz?.["choices"];
  if (!Array.isArray(opciones) || opciones.length === 0) {
    throw new ErrorProveedor("la respuesta no trae choices", {
      recuperable: false,
      codigo: "respuesta_ilegible",
    });
  }
  const primera = leerObjeto(opciones[0]);
  const mensaje = leerObjeto(primera?.["message"]);
  if (mensaje === undefined) {
    throw new ErrorProveedor("la respuesta no trae message", {
      recuperable: false,
      codigo: "respuesta_ilegible",
    });
  }

  const texto = leerTexto(mensaje["content"]) ?? "";
  const crudas = mensaje["tool_calls"];
  const llamadas: PeticionLlamada[] = [];

  if (Array.isArray(crudas)) {
    for (const [indice, cruda] of crudas.entries()) {
      const llamada = leerObjeto(cruda);
      const funcion = leerObjeto(llamada?.["function"]);
      const nombre = leerTexto(funcion?.["name"]);
      if (nombre === undefined) {
        throw new ErrorProveedor(
          `la llamada ${indice} no trae nombre de funcion`,
          { recuperable: false, codigo: "respuesta_ilegible" },
        );
      }
      llamadas.push({
        id: leerTexto(llamada?.["id"]) ?? `openai-${indice}`,
        nombre,
        argumentos: argumentosDeLlamada(
          leerTexto(funcion?.["arguments"]) ?? "",
        ),
      });
    }
  }

  if (llamadas.length > 0) {
    return { tipo: "llamadas", texto, llamadas };
  }
  return { tipo: "texto", texto };
}

function mensajeDeError(estado: number, cuerpo: string): string {
  let detalle = recortar(cuerpo.trim());
  try {
    const analizado: unknown = JSON.parse(cuerpo);
    const error = leerObjeto(leerObjeto(analizado)?.["error"]);
    const texto = leerTexto(error?.["message"]);
    if (texto !== undefined) {
      detalle = recortar(texto);
    }
  } catch {
    // Se queda el cuerpo crudo recortado.
  }
  return `OpenAI respondio ${estado}: ${detalle === "" ? "(sin cuerpo)" : detalle}`;
}

interface FalloConEspera {
  readonly error: ErrorProveedor;
  /** Espera pedida por el servidor, si la pidio. */
  readonly esperaPedidaMs: number | undefined;
}

export class AdaptadorOpenAI implements AdaptadorProveedor {
  readonly nombre = "openai";

  readonly config: ConfiguracionOpenAI;

  /** Privada de verdad: no es enumerable ni sale en JSON.stringify. */
  readonly #clave: string;

  constructor(opciones: OpcionesOpenAI = {}) {
    const clave = process.env["OPENAI_API_KEY"];
    if (clave === undefined || clave.trim() === "") {
      throw new ErrorProveedor(
        "falta OPENAI_API_KEY: define la clave en el entorno antes de construir el adaptador de OpenAI",
        { recuperable: false, codigo: "sin_clave" },
      );
    }
    this.#clave = clave;
    this.config = {
      urlBase: opciones.urlBase ?? URL_BASE_POR_DEFECTO,
      modelo: opciones.modelo ?? MODELO_POR_DEFECTO,
      timeoutMs: opciones.timeoutMs ?? TIMEOUT_MS_POR_DEFECTO,
      intentos: opciones.intentos ?? INTENTOS_POR_DEFECTO,
      esperaInicialMs:
        opciones.esperaInicialMs ?? ESPERA_INICIAL_MS_POR_DEFECTO,
      factorEspera: opciones.factorEspera ?? FACTOR_ESPERA_POR_DEFECTO,
      esperaMaximaMs: opciones.esperaMaximaMs ?? ESPERA_MAXIMA_MS_POR_DEFECTO,
    };
  }

  async enviar(
    mensajes: readonly Mensaje[],
    herramientas: readonly DeclaracionHerramienta[],
  ): Promise<RespuestaProveedor> {
    const cuerpo = JSON.stringify({
      model: this.config.modelo,
      messages: haciaOpenAI(mensajes),
      ...(herramientas.length === 0
        ? {}
        : {
            tools: herramientasHaciaOpenAI(herramientas),
            tool_choice: "auto",
          }),
    });

    let ultimo: ErrorProveedor | undefined;

    for (let intento = 1; intento <= this.config.intentos; intento += 1) {
      const resultado = await this.unIntento(cuerpo);
      if (resultado.ok) {
        return resultado.respuesta;
      }
      ultimo = resultado.fallo.error;

      // Un error no recuperable no se reintenta.
      if (!ultimo.recuperable || intento === this.config.intentos) {
        throw ultimo;
      }

      await dormir(
        resultado.fallo.esperaPedidaMs ?? this.esperaCalculada(intento),
      );
    }

    throw (
      ultimo ??
      new ErrorProveedor("fallo sin diagnostico", {
        recuperable: false,
        codigo: "desconocido",
      })
    );
  }

  /** Espera creciente: inicial * factor^(intento-1), con tope. */
  private esperaCalculada(intento: number): number {
    const espera =
      this.config.esperaInicialMs *
      Math.pow(this.config.factorEspera, intento - 1);
    return Math.min(espera, this.config.esperaMaximaMs);
  }

  private async unIntento(
    cuerpo: string,
  ): Promise<
    | { ok: true; respuesta: RespuestaProveedor }
    | { ok: false; fallo: FalloConEspera }
  > {
    const control = new AbortController();
    let vencido = false;
    const temporizador = setTimeout(() => {
      vencido = true;
      control.abort();
    }, this.config.timeoutMs);

    try {
      const respuesta = await fetch(
        `${this.config.urlBase.replace(/\/$/u, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.#clave}`,
          },
          body: cuerpo,
          signal: control.signal,
        },
      );

      const texto = await respuesta.text();

      if (!respuesta.ok) {
        return {
          ok: false,
          fallo: {
            error: new ErrorProveedor(
              mensajeDeError(respuesta.status, texto),
              {
                recuperable: esEstadoRecuperable(respuesta.status),
                codigo: codigoDeEstado(respuesta.status),
              },
            ),
            esperaPedidaMs: esperaDeCabecera(respuesta.headers),
          },
        };
      }

      let analizado: unknown;
      try {
        analizado = JSON.parse(texto);
      } catch {
        return {
          ok: false,
          fallo: {
            error: new ErrorProveedor(
              `la respuesta de OpenAI no es JSON valido: ${recortar(texto.trim(), 120)}`,
              { recuperable: false, codigo: "respuesta_ilegible" },
            ),
            esperaPedidaMs: undefined,
          },
        };
      }

      return { ok: true, respuesta: desdeOpenAI(analizado) };
    } catch (causa: unknown) {
      return {
        ok: false,
        fallo: {
          error: this.traducir(causa, vencido),
          esperaPedidaMs: undefined,
        },
      };
    } finally {
      clearTimeout(temporizador);
    }
  }

  /** Traduce lo que lanza fetch, o lo que lanza el lector de la respuesta. */
  private traducir(causa: unknown, vencido: boolean): ErrorProveedor {
    if (causa instanceof ErrorProveedor) {
      return causa;
    }
    if (vencido) {
      return new ErrorProveedor(
        `la peticion a OpenAI supero el limite de ${this.config.timeoutMs} ms`,
        { recuperable: true, codigo: "timeout" },
      );
    }
    const detalle = causa instanceof Error ? causa.message : String(causa);
    return new ErrorProveedor(`fallo de red hablando con OpenAI: ${detalle}`, {
      recuperable: true,
      codigo: "red",
    });
  }
}
