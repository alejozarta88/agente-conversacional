import type { DeclaracionHerramienta } from "../tools/contrato.js";
import {
  ErrorProveedor,
  type AdaptadorProveedor,
  type Mensaje,
  type PeticionLlamada,
  type RespuestaProveedor,
} from "./adapter.js";

/**
 * Proveedor falso: implementa la interfaz sin red ni clave. Se construye con
 * un guion y va devolviendo sus actos en orden.
 */

/** Una llamada pedida por el guion; el id lo pone el proveedor. */
export interface LlamadaGuion {
  readonly nombre: string;
  readonly argumentos: unknown;
}

export type ActoGuion =
  | { readonly tipo: "texto"; readonly texto: string }
  | {
      readonly tipo: "llamadas";
      readonly texto?: string;
      readonly llamadas: readonly LlamadaGuion[];
    }
  | {
      readonly tipo: "error";
      readonly mensaje: string;
      readonly recuperable: boolean;
      readonly codigo?: string;
    };

/** Que hacer cuando el guion se agota. */
export type AlAgotar =
  /** Repetir el ultimo acto para siempre: asi se prueba el tope. */
  | { readonly modo: "repetir-ultimo" }
  /** Responder un texto fijo. */
  | { readonly modo: "texto"; readonly texto: string }
  /** Fallar: delata un guion mal escrito en una prueba. */
  | { readonly modo: "error" };

export interface OpcionesFalso {
  readonly alAgotar?: AlAgotar;
  readonly nombre?: string;
}

export class ProveedorFalso implements AdaptadorProveedor {
  readonly nombre: string;

  private readonly guion: readonly ActoGuion[];
  private readonly alAgotar: AlAgotar;
  private indice = 0;
  private contadorLlamadas = 0;

  /** Historiales que el ciclo le fue pasando, para poder inspeccionarlos. */
  private readonly recibidos: (readonly Mensaje[])[] = [];

  constructor(guion: readonly ActoGuion[], opciones: OpcionesFalso = {}) {
    this.guion = guion;
    this.alAgotar = opciones.alAgotar ?? { modo: "error" };
    this.nombre = opciones.nombre ?? "falso";
  }

  /** Cuantas veces se llamo a enviar(). */
  get envios(): number {
    return this.recibidos.length;
  }

  /** Historial tal como lo vio el proveedor en el envio numero n (1-based). */
  historialDelEnvio(n: number): readonly Mensaje[] {
    return this.recibidos[n - 1] ?? [];
  }

  /** Ultimo historial recibido. */
  get ultimoHistorial(): readonly Mensaje[] {
    return this.historialDelEnvio(this.recibidos.length);
  }

  async enviar(
    mensajes: readonly Mensaje[],
    _herramientas: readonly DeclaracionHerramienta[],
  ): Promise<RespuestaProveedor> {
    this.recibidos.push([...mensajes]);
    const acto = this.proximoActo();

    if (acto.tipo === "error") {
      throw new ErrorProveedor(acto.mensaje, {
        recuperable: acto.recuperable,
        codigo: acto.codigo ?? "falso",
      });
    }

    if (acto.tipo === "texto") {
      return { tipo: "texto", texto: acto.texto };
    }

    const llamadas: PeticionLlamada[] = acto.llamadas.map((llamada) => {
      this.contadorLlamadas += 1;
      return {
        id: `falso-${this.contadorLlamadas}`,
        nombre: llamada.nombre,
        argumentos: llamada.argumentos,
      };
    });

    return { tipo: "llamadas", texto: acto.texto ?? "", llamadas };
  }

  private proximoActo(): ActoGuion {
    const acto = this.guion[this.indice];
    if (acto !== undefined) {
      this.indice += 1;
      return acto;
    }

    if (this.alAgotar.modo === "texto") {
      return { tipo: "texto", texto: this.alAgotar.texto };
    }

    if (this.alAgotar.modo === "repetir-ultimo") {
      const ultimo = this.guion[this.guion.length - 1];
      if (ultimo !== undefined) {
        return ultimo;
      }
    }

    return {
      tipo: "error",
      mensaje: "guion agotado y sin acto de reserva",
      recuperable: false,
      codigo: "guion-agotado",
    };
  }
}
