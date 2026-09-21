import { z } from "zod";
import { definir, respuestaOk } from "./contrato.js";

/**
 * HERRAMIENTAS PROVISIONALES DE RELLENO.
 * Existen solo para ejercitar el contrato (validacion, sobre JSON y
 * contencion de excepciones). Son reemplazables: borrar este archivo no debe
 * afectar a nada mas que al registro de ejemplo y a prueba-contrato.ts.
 */

/** Provisional. Suma dos numeros y devuelve ok true. */
export const sumar = definir({
  description: "Suma dos numeros enteros o decimales y devuelve el total.",
  args: z.object({
    a: z.number().describe("Primer sumando."),
    b: z.number().describe("Segundo sumando."),
  }),
  execute: ({ a, b }) => respuestaOk({ total: a + b }),
});

/** Provisional. Lanza siempre, para probar la contencion de ejecutar(). */
export const explotar = definir({
  description:
    "Lanza una excepcion a proposito. Sirve para verificar que el contrato contiene los fallos.",
  args: z.object({
    motivo: z
      .string()
      .min(1)
      .describe("Texto que acompana a la excepcion lanzada."),
  }),
  execute: ({ motivo }) => {
    throw new Error(`fallo provocado: ${motivo}`);
  },
});
