import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";

import {
  camposDeArgumentos,
  ejecutarTurno,
  type CampoArgumento,
  type ConfiguracionCiclo,
  type DisposicionLlamada,
  type LlamadaPendiente,
  type LlamadaRealizada,
  type ResultadoTurno,
} from "./agente/ciclo.js";
import type { AdaptadorProveedor, Mensaje } from "./llm/adapter.js";
import type { Registro } from "./tools/contrato.js";

/**
 * Servidor HTTP del agente. Sin framework: node:http y nada mas.
 *
 * Aqui NO se lee la clave del proveedor: el adaptador llega ya construido
 * por inyeccion, asi la prueba puede meter el proveedor falso.
 */

/** Control de gasto y de abuso. UN SOLO SITIO para todos los topes. */
export const LIMITES_POR_DEFECTO = {
  /** Mensajes de usuario por sesion. */
  mensajesPorSesion: 30,
  /** Sesiones vivas a la vez en memoria. */
  sesionesSimultaneas: 20,
  /** Inactividad tras la cual una sesion caduca y se puede purgar. */
  inactividadMs: 30 * 60 * 1000,
  /** Tope de bytes del cuerpo de una peticion. */
  bytesCuerpo: 64 * 1024,
  /** Tope de caracteres de un mensaje del usuario. */
  caracteresMensaje: 4000,
  /**
   * Tope de tokens por sesion. Requisito no funcional: "un usuario no
   * puede gastar tu clave sin limite". 0 = sin tope.
   */
  tokensPorSesion: 120_000,
} as const;

export interface Limites {
  readonly mensajesPorSesion?: number;
  readonly sesionesSimultaneas?: number;
  readonly inactividadMs?: number;
  readonly bytesCuerpo?: number;
  readonly caracteresMensaje?: number;
  readonly tokensPorSesion?: number;
}

export interface OpcionesServidor {
  readonly adaptador: AdaptadorProveedor;
  readonly registro: Registro;
  readonly configuracionCiclo?: ConfiguracionCiclo;
  readonly limites?: Limites;
  /** Ruta del index.html a servir en /. */
  readonly rutaIndex?: string;
  /** Ruta del system prompt. Vive en un archivo, no en el codigo. */
  readonly rutaPrompt?: string;
  /**
   * Ruta de la capa de conocimiento: las reglas del proceso. Va aparte
   * del prompt a proposito. El prompt dice COMO se conduce el agente; el
   * conocimiento dice COMO FUNCIONA el negocio. Se pueden cambiar las
   * reglas del proceso sin tocar el comportamiento, y al reves.
   */
  readonly rutaConocimiento?: string;
}

/** Lo que el front pinta. Nunca lleva nada del proveedor ni de la clave. */
export type Evento =
  | { readonly tipo: "usuario"; readonly texto: string }
  | { readonly tipo: "agente"; readonly texto: string }
  | {
      readonly tipo: "herramienta";
      readonly nombre: string;
      readonly argumentos: unknown;
      /** Aplanados por el ciclo, para que el front no formatee JSON. */
      readonly campos: readonly CampoArgumento[];
      readonly ok: boolean;
      readonly disposicion: DisposicionLlamada;
      readonly resumen: string;
    }
  | {
      readonly tipo: "pendiente";
      readonly nombre: string;
      readonly argumentos: unknown;
      /** Ya aplanados por el ciclo: el front los pinta, no los formatea. */
      readonly campos: readonly CampoArgumento[];
    }
  | { readonly tipo: "error"; readonly texto: string }
  | { readonly tipo: "aviso"; readonly texto: string };

interface Sesion {
  readonly id: string;
  /** Instante del ultimo uso, para caducar por inactividad. */
  ultimoUso: number;
  historial: readonly Mensaje[];
  /** El estado pendiente vive AQUI, no en el cliente. */
  pendiente: LlamadaPendiente | undefined;
  mensajesUsados: number;
  /** Acumulado real de la sesion, sumando lo que gasta cada turno. */
  tokensUsados: number;
  readonly eventos: Evento[];
}

interface VistaSesion {
  readonly sesionId: string;
  readonly eventos: readonly Evento[];
  readonly esperandoConfirmacion: {
    readonly nombre: string;
    readonly argumentos: unknown;
    readonly campos: readonly CampoArgumento[];
  } | null;
  readonly mensajesUsados: number;
  readonly mensajesPorSesion: number;
  readonly tokensUsados: number;
  readonly tokensPorSesion: number;
}

function resumirSobre(resultado: string): string {
  try {
    const analizado: unknown = JSON.parse(resultado);
    if (typeof analizado === "object" && analizado !== null) {
      const sobre = analizado as { ok?: unknown; data?: unknown; error?: unknown };
      const bruto =
        sobre.ok === true ? JSON.stringify(sobre.data) : String(sobre.error ?? "");
      const texto = bruto ?? "null";
      return texto.length > 300 ? `${texto.slice(0, 297)}...` : texto;
    }
  } catch {
    // Cae al texto crudo.
  }
  return resultado.length > 300 ? `${resultado.slice(0, 297)}...` : resultado;
}

function eventoDeLlamada(llamada: LlamadaRealizada): Evento {
  return {
    tipo: "herramienta",
    nombre: llamada.nombre,
    argumentos: llamada.argumentos,
    campos: camposDeArgumentos(llamada.argumentos),
    ok: llamada.ok,
    disposicion: llamada.disposicion,
    resumen: resumirSobre(llamada.resultado),
  };
}

function volcarTurno(sesion: Sesion, resultado: ResultadoTurno): void {
  sesion.historial = resultado.historial;
  sesion.pendiente = resultado.esperandoConfirmacion;
  // El gasto se acumula por sesion, que es la unidad del tope.
  sesion.tokensUsados += resultado.tokensUsados;

  for (const llamada of resultado.llamadas) {
    sesion.eventos.push(eventoDeLlamada(llamada));
  }

  if (resultado.motivoFin === "error-proveedor") {
    sesion.eventos.push({ tipo: "error", texto: resultado.respuesta });
    return;
  }
  if (resultado.motivoFin === "confirmacion") {
    const pendiente = resultado.esperandoConfirmacion;
    if (pendiente !== undefined) {
      sesion.eventos.push({
        tipo: "pendiente",
        nombre: pendiente.llamada.nombre,
        argumentos: pendiente.llamada.argumentos,
        campos: camposDeArgumentos(pendiente.llamada.argumentos),
      });
    }
    return;
  }
  sesion.eventos.push({ tipo: "agente", texto: resultado.respuesta });
}

/**
 * Quita el frontmatter YAML de un documento del modulo.
 *
 * `modulo/agent.md` y `SKILL.md` lo llevan porque el PRD lo exige para que
 * otras plataformas de agentes los reconozcan. Pero eso son metadatos DEL
 * ARCHIVO, no instrucciones para el modelo: meter `permission: {edit:
 * deny}` en un mensaje de sistema solo puede confundirlo sobre lo que
 * puede hacer. El modelo recibe el cuerpo.
 */
export function sinFrontmatter(texto: string): string {
  const limpio = texto.replace(/^﻿/u, "").trimStart();
  if (!limpio.startsWith("---")) {
    return limpio.trim();
  }
  const lineas = limpio.split(/\r?\n/u);
  for (let indice = 1; indice < lineas.length; indice += 1) {
    if ((lineas[indice] ?? "").trim() === "---") {
      return lineas
        .slice(indice + 1)
        .join("\n")
        .trim();
    }
  }
  // Abre frontmatter y no lo cierra: se devuelve tal cual en vez de
  // tragarse el documento entero.
  return limpio.trim();
}

function leerObjeto(valor: unknown): Record<string, unknown> | undefined {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    return undefined;
  }
  return valor as Record<string, unknown>;
}

/** Se lanza cuando el cuerpo supera el tope de bytes. */
class CuerpoExcesivo extends Error {
  constructor(readonly tope: number) {
    super(`cuerpo mayor que ${tope} bytes`);
    this.name = "CuerpoExcesivo";
  }
}

/**
 * Lee el cuerpo con tope de bytes. Al pasarse deja de acumular y tira lo
 * leido; sigue drenando el flujo para poder contestar, pero la memoria no
 * crece mas.
 */
async function leerCuerpo(
  peticion: IncomingMessage,
  topeBytes: number,
): Promise<unknown> {
  let trozos: Buffer[] = [];
  let total = 0;
  let excedido = false;
  for await (const trozo of peticion) {
    const bloque = Buffer.from(trozo);
    total += bloque.length;
    if (excedido) {
      continue;
    }
    if (total > topeBytes) {
      excedido = true;
      trozos = [];
      continue;
    }
    trozos.push(bloque);
  }
  if (excedido) {
    throw new CuerpoExcesivo(topeBytes);
  }
  const texto = Buffer.concat(trozos).toString("utf8");
  if (texto.trim() === "") {
    return undefined;
  }
  return JSON.parse(texto) as unknown;
}

function responderJson(
  respuesta: ServerResponse,
  estado: number,
  cuerpo: unknown,
): void {
  const texto = JSON.stringify(cuerpo);
  respuesta.writeHead(estado, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  respuesta.end(texto);
}

export function crearServidor(opciones: OpcionesServidor): Server {
  const limites = {
    mensajesPorSesion:
      opciones.limites?.mensajesPorSesion ??
      LIMITES_POR_DEFECTO.mensajesPorSesion,
    sesionesSimultaneas:
      opciones.limites?.sesionesSimultaneas ??
      LIMITES_POR_DEFECTO.sesionesSimultaneas,
    inactividadMs:
      opciones.limites?.inactividadMs ?? LIMITES_POR_DEFECTO.inactividadMs,
    bytesCuerpo:
      opciones.limites?.bytesCuerpo ?? LIMITES_POR_DEFECTO.bytesCuerpo,
    tokensPorSesion:
      opciones.limites?.tokensPorSesion ?? LIMITES_POR_DEFECTO.tokensPorSesion,
    caracteresMensaje:
      opciones.limites?.caracteresMensaje ??
      LIMITES_POR_DEFECTO.caracteresMensaje,
  };
  const rutaIndex =
    opciones.rutaIndex ??
    fileURLToPath(new URL("../web/index.html", import.meta.url));

  const rutaPrompt =
    opciones.rutaPrompt ??
    fileURLToPath(new URL("../modulo/agent.md", import.meta.url));

  // Las dos capas viven en modulo/, que es el paquete reutilizable del
  // bonus. No son copias: son LOS originales, y la aplicacion los consume
  // desde ahi. Asi no pueden divergir de lo que se entrega. Ver SOLUCION.md.
  const rutaConocimiento =
    opciones.rutaConocimiento ??
    fileURLToPath(
      new URL("../modulo/skill/registro-contratos/SKILL.md", import.meta.url),
    );

  const sesiones = new Map<string, Sesion>();

  /** Se lee una vez del disco y se cachea. Nunca va embebido en el codigo. */
  let promptSistema: string | undefined;
  let conocimiento: string | undefined;

  async function leerArchivo(ruta: string, que: string): Promise<string> {
    try {
      return sinFrontmatter(await readFile(ruta, "utf8"));
    } catch {
      console.error(
        `[servidor] no se pudo leer ${que} en ${ruta}; se sigue sin el`,
      );
      return "";
    }
  }

  async function obtenerPrompt(): Promise<string> {
    if (promptSistema === undefined) {
      promptSistema = await leerArchivo(rutaPrompt, "el system prompt");
    }
    return promptSistema;
  }

  async function obtenerConocimiento(): Promise<string> {
    if (conocimiento === undefined) {
      conocimiento = await leerArchivo(
        rutaConocimiento,
        "la capa de conocimiento",
      );
    }
    return conocimiento;
  }

  /**
   * Purga por inactividad. Se llama al atender cada peticion, no con un
   * temporizador: asi no hay nada que impida al proceso terminar.
   */
  function purgarCaducadas(ahora: number): number {
    let purgadas = 0;
    for (const [id, sesion] of sesiones) {
      if (ahora - sesion.ultimoUso >= limites.inactividadMs) {
        sesiones.delete(id);
        purgadas += 1;
      }
    }
    return purgadas;
  }

  /** La mas antigua por ultimo uso. Se usa solo si tras purgar sigue lleno. */
  function expulsarMasAntigua(): string | undefined {
    let victima: Sesion | undefined;
    for (const sesion of sesiones.values()) {
      if (victima === undefined || sesion.ultimoUso < victima.ultimoUso) {
        victima = sesion;
      }
    }
    if (victima === undefined) {
      return undefined;
    }
    sesiones.delete(victima.id);
    return victima.id;
  }

  /**
   * El id lo emite el SERVIDOR. Al llegar al tope se purga y, si aun asi
   * esta lleno, se expulsa la mas antigua: nunca se rechaza al que llega.
   */
  async function crearSesion(ahora: number): Promise<Sesion> {
    if (sesiones.size >= limites.sesionesSimultaneas) {
      const expulsada = expulsarMasAntigua();
      if (expulsada !== undefined) {
        console.log(`[servidor] sesion expulsada por antiguedad: ${expulsada}`);
      }
    }
    const prompt = await obtenerPrompt();
    const reglas = await obtenerConocimiento();
    // Dos mensajes de sistema separados, en este orden: comportamiento y
    // luego conocimiento. No se concatenan para que cada capa siga siendo
    // identificable en el historial.
    const sistema = [prompt, reglas]
      .filter((texto) => texto !== "")
      .map((texto) => ({ rol: "sistema" as const, texto }));
    const sesion: Sesion = {
      id: randomUUID(),
      ultimoUso: ahora,
      historial: sistema,
      pendiente: undefined,
      mensajesUsados: 0,
      tokensUsados: 0,
      eventos: [],
    };
    sesiones.set(sesion.id, sesion);
    return sesion;
  }

  function vista(sesion: Sesion): VistaSesion {
    return {
      sesionId: sesion.id,
      eventos: sesion.eventos,
      esperandoConfirmacion:
        sesion.pendiente === undefined
          ? null
          : {
              nombre: sesion.pendiente.llamada.nombre,
              argumentos: sesion.pendiente.llamada.argumentos,
              campos: camposDeArgumentos(sesion.pendiente.llamada.argumentos),
            },
      mensajesUsados: sesion.mensajesUsados,
      mensajesPorSesion: limites.mensajesPorSesion,
      tokensUsados: sesion.tokensUsados,
      tokensPorSesion: limites.tokensPorSesion,
    };
  }

  async function turno(
    sesion: Sesion,
    mensajeUsuario: string,
    confirmacion: { aprobada: boolean; motivo?: string } | undefined,
  ): Promise<void> {
    const pendiente = sesion.pendiente;
    const resultado = await ejecutarTurno({
      historial: sesion.historial,
      mensajeUsuario,
      registro: opciones.registro,
      adaptador: opciones.adaptador,
      // El tope de tokens es de la SESION, asi que el servidor le pasa al
      // ciclo cuanto lleva gastado esta. El ciclo lo mira antes de cada
      // envio y corta el turno si se agota.
      configuracion: {
        ...opciones.configuracionCiclo,
        topeTokensSesion: limites.tokensPorSesion,
        tokensGastadosAntes: sesion.tokensUsados,
      },
      ...(confirmacion === undefined || pendiente === undefined
        ? {}
        : {
            confirmacion: {
              pendiente,
              aprobada: confirmacion.aprobada,
              ...(confirmacion.motivo === undefined
                ? {}
                : { motivo: confirmacion.motivo }),
            },
          }),
    });
    volcarTurno(sesion, resultado);
  }

  async function manejarChat(
    peticion: IncomingMessage,
    respuesta: ServerResponse,
  ): Promise<void> {
    const ahora = Date.now();
    let cuerpo: unknown;
    try {
      cuerpo = await leerCuerpo(peticion, limites.bytesCuerpo);
    } catch (causa: unknown) {
      if (causa instanceof CuerpoExcesivo) {
        responderJson(respuesta, 413, {
          error: `El mensaje que has enviado es demasiado grande: el limite son ${limites.bytesCuerpo} bytes.`,
        });
        return;
      }
      responderJson(respuesta, 400, {
        error: "El cuerpo de la peticion no es JSON valido.",
      });
      return;
    }

    const datos = leerObjeto(cuerpo);
    const sesionIdCrudo = datos?.["sesionId"];
    if (sesionIdCrudo !== undefined && typeof sesionIdCrudo !== "string") {
      responderJson(respuesta, 400, {
        error: "El sesionId, si lo mandas, tiene que ser texto.",
      });
      return;
    }

    const confirmacionCruda = leerObjeto(datos?.["confirmacion"]);
    const mensaje = datos?.["mensaje"];

    let sesion: Sesion;
    if (sesionIdCrudo === undefined || sesionIdCrudo === "") {
      // Sin id: el servidor emite uno nuevo y lo devuelve en la vista.
      sesion = await crearSesion(ahora);
    } else {
      // Con id: tiene que ser uno que emitiera este servidor y siga vivo.
      const encontrada = sesiones.get(sesionIdCrudo);
      if (encontrada === undefined) {
        responderJson(respuesta, 404, {
          error:
            "Esa conversacion no existe o ha caducado. Empieza una nueva y vuelve a escribir.",
        });
        return;
      }
      sesion = encontrada;
    }
    sesion.ultimoUso = ahora;

    // Rama de confirmacion: el cliente solo dice si aprueba o no.
    if (confirmacionCruda !== undefined) {
      const aprobada = confirmacionCruda["aprobada"];
      if (typeof aprobada !== "boolean") {
        responderJson(respuesta, 400, {
          error: "La confirmacion necesita el campo booleano aprobada.",
        });
        return;
      }
      if (sesion.pendiente === undefined) {
        sesion.eventos.push({
          tipo: "aviso",
          texto: "No hay ninguna accion esperando confirmacion.",
        });
        responderJson(respuesta, 200, vista(sesion));
        return;
      }
      const motivo = confirmacionCruda["motivo"];
      await turno(sesion, "", {
        aprobada,
        ...(typeof motivo === "string" && motivo !== ""
          ? { motivo }
          : aprobada
            ? {}
            : { motivo: "denegada desde la interfaz" }),
      });
      responderJson(respuesta, 200, vista(sesion));
      return;
    }

    if (typeof mensaje !== "string" || mensaje.trim() === "") {
      responderJson(respuesta, 400, {
        error: "Falta el mensaje, o viene vacio.",
      });
      return;
    }

    if (mensaje.length > limites.caracteresMensaje) {
      responderJson(respuesta, 400, {
        error: `Tu mensaje tiene ${mensaje.length} caracteres y el limite son ${limites.caracteresMensaje}. Acortalo y vuelve a enviarlo.`,
      });
      return;
    }

    if (sesion.pendiente !== undefined) {
      sesion.eventos.push({
        tipo: "aviso",
        texto:
          "Hay una accion esperando tu confirmacion. Confirmala o deniegala antes de seguir escribiendo.",
      });
      responderJson(respuesta, 200, vista(sesion));
      return;
    }

    if (sesion.mensajesUsados >= limites.mensajesPorSesion) {
      sesion.eventos.push({
        tipo: "aviso",
        texto: `Has llegado al tope de ${limites.mensajesPorSesion} mensajes en esta conversacion. Abre una conversacion nueva para seguir.`,
      });
      responderJson(respuesta, 200, vista(sesion));
      return;
    }

    sesion.mensajesUsados += 1;
    sesion.eventos.push({ tipo: "usuario", texto: mensaje });
    await turno(sesion, mensaje, undefined);
    responderJson(respuesta, 200, vista(sesion));
  }

  return createServer((peticion, respuesta) => {
    void (async (): Promise<void> => {
      const url = new URL(peticion.url ?? "/", "http://localhost");
      const ruta = url.pathname;
      const metodo = peticion.method ?? "GET";

      // La purga va aqui, al atender: sin setInterval, nada retiene el
      // proceso abierto.
      purgarCaducadas(Date.now());

      try {
        if (metodo === "GET" && ruta === "/api/health") {
          responderJson(respuesta, 200, {
            estado: "vivo",
            sesiones: sesiones.size,
            mensajesPorSesion: limites.mensajesPorSesion,
            sesionesSimultaneas: limites.sesionesSimultaneas,
          });
          return;
        }

        if (metodo === "POST" && ruta === "/api/chat") {
          await manejarChat(peticion, respuesta);
          return;
        }

        if (metodo === "GET" && ruta.startsWith("/api/sessions/")) {
          const id = decodeURIComponent(ruta.slice("/api/sessions/".length));
          const sesion = sesiones.get(id);
          if (sesion === undefined) {
            responderJson(respuesta, 404, {
              error:
                "Esa conversacion no existe o ha caducado. Empieza una nueva y vuelve a escribir.",
            });
            return;
          }
          sesion.ultimoUso = Date.now();
          responderJson(respuesta, 200, vista(sesion));
          return;
        }

        if (metodo === "GET" && (ruta === "/" || ruta === "/index.html")) {
          const html = await readFile(rutaIndex, "utf8");
          respuesta.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          respuesta.end(html);
          return;
        }

        responderJson(respuesta, 404, { error: "Ruta desconocida." });
      } catch (causa: unknown) {
        // Ni la causa cruda ni nada del entorno salen al cliente.
        console.error("[servidor] fallo inesperado:", causa);
        responderJson(respuesta, 500, {
          error: "El servidor tuvo un fallo inesperado.",
        });
      }
    })();
  });
}
