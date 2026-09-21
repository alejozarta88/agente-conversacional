import { z } from "zod";
import { definir, respuestaError, respuestaOk } from "./contrato.js";

/**
 * HERRAMIENTAS PROVISIONALES DE LABORATORIO.
 * Existen para ejercitar el ciclo sin red ni clave: una con efecto
 * observable, una que devuelve error legitimo y una que rechaza una promesa.
 * Reemplazables: no hay nada de produccion aqui.
 */

/** Efectos observables, para que las pruebas comprueben que NO ocurrieron. */
export const efectos: { borrados: string[] } = { borrados: [] };

export function reiniciarEfectos(): void {
  efectos.borrados.length = 0;
}

/** Provisional. Devuelve el texto en mayusculas. */
export const eco = definir({
  description: "Devuelve el texto recibido en mayusculas.",
  args: z.object({
    texto: z.string().min(1).describe("Texto a repetir."),
  }),
  execute: ({ texto }) => respuestaOk({ eco: texto.toUpperCase() }),
});

/** Provisional. Error legitimo de herramienta: sobre valido con ok false. */
export const fallar = definir({
  description: "Falla siempre, devolviendo un sobre de error bien formado.",
  args: z.object({
    causa: z.string().min(1).describe("Causa del fallo simulado."),
  }),
  execute: ({ causa }) => respuestaError(`fallo simulado: ${causa}`),
});

/** Provisional. Rechaza una promesa: excepcion asincrona. */
export const explotarAsync = definir({
  description: "Rechaza una promesa a proposito.",
  args: z.object({
    motivo: z.string().min(1).describe("Motivo del rechazo."),
  }),
  execute: async ({ motivo }) => {
    await Promise.resolve();
    throw new Error(`rechazo asincrono: ${motivo}`);
  },
});

/** Provisional. Tiene efecto observable: por eso exige confirmacion. */
export const borrar = definir({
  description: "Borra un recurso por su nombre.",
  args: z.object({
    recurso: z.string().min(1).describe("Nombre del recurso a borrar."),
  }),
  execute: ({ recurso }) => {
    efectos.borrados.push(recurso);
    return respuestaOk({ borrado: recurso });
  },
});

/** Provisional. Mal escrita a proposito: no devuelve un sobre JSON. */
export const malEscrita = definir({
  description: "Devuelve texto plano en vez del sobre JSON del contrato.",
  args: z.object({
    entrada: z.string().min(1).describe("Cualquier texto; se ignora."),
  }),
  execute: () => "esto no es un sobre JSON",
});
