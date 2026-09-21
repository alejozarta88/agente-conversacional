import { combinar, registrar, type Registro } from "./tools/contrato.js";
import {
  alertas,
  extraer,
  leer_buzon,
  registrar as registrarContrato,
  validar,
} from "./tools/contratos.js";

/**
 * El registro que ve el agente y la lista de lo que exige aprobacion
 * humana. Vive aparte de inicio.ts a proposito: inicio.ts limpia out\ y
 * levanta el servidor al importarse, asi que no se puede inspeccionar sin
 * efectos. Esto si.
 *
 * ejemplo.ts y laboratorio.ts NO se registran aqui. Siguen en el proyecto
 * porque prueba-contrato y prueba-ciclo los necesitan para ejercitar el
 * contrato y la guardia con herramientas de juguete, pero el modelo no
 * debe verlas.
 */
export const REGISTRO_AGENTE: Registro = combinar(
  registrar("contratos.ts", {
    leer_buzon,
    extraer,
    validar,
    registrar: registrarContrato,
    alertas,
  }),
);

/**
 * La UNICA herramienta que exige aprobacion humana antes de correr.
 *
 * Esta constante es la que hace real la guarda descrita en S-22. Las otras
 * cuatro no la necesitan: leer_buzon, extraer y validar son de solo
 * lectura, y alertas escribe un reporte idempotente que no cambia ningun
 * dato del negocio.
 *
 * Sin esta linea, `confirmado: true` no significaria nada, porque lo
 * compone el modelo: la barrera que cuenta es la del ciclo, no la del
 * argumento. Verificado en prueba-contratos.ts.
 */
export const EXIGEN_APROBACION: readonly string[] = ["contratos_registrar"];

/** Tope de iteraciones herramienta -> modelo por turno (CA1). */
export const TOPE_ITERACIONES = 25;
