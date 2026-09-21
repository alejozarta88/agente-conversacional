import {
  combinar,
  ejecutar,
  esClaseError,
  registrar,
  type ClaseError,
} from "./src/tools/contrato.js";
import * as ejemplo from "./src/tools/ejemplo.js";
import { malEscrita } from "./src/tools/laboratorio.js";

/**
 * Verificacion del contrato de herramientas. Sin framework, sin clave, sin red.
 * Sale con codigo distinto de cero si alguna verificacion falla.
 */

const registro = combinar(
  registrar("ejemplo.ts", ejemplo),
  registrar("laboratorio.ts", { malEscrita }),
);

interface Verificacion {
  titulo: string;
  nombre: string;
  argumentos: unknown;
  esperado: boolean;
  /** undefined = el sobre de exito, que no lleva clase. */
  claseEsperada: ClaseError | undefined;
}

const verificaciones: readonly Verificacion[] = [
  {
    titulo: "llamada valida devuelve ok true y ninguna clase",
    nombre: "ejemplo_sumar",
    argumentos: { a: 2, b: 3 },
    esperado: true,
    claseEsperada: undefined,
  },
  {
    titulo: "argumentos invalidos devuelven ok false sin lanzar",
    nombre: "ejemplo_sumar",
    argumentos: { a: "dos", b: null },
    esperado: false,
    claseEsperada: "argumentos_invalidos",
  },
  {
    titulo: "herramienta que lanza queda contenida",
    nombre: "ejemplo_explotar",
    argumentos: { motivo: "prueba" },
    esperado: false,
    claseEsperada: "excepcion_contenida",
  },
  {
    titulo: "herramienta desconocida devuelve ok false",
    nombre: "ejemplo_inexistente",
    argumentos: {},
    esperado: false,
    claseEsperada: "herramienta_desconocida",
  },
  {
    titulo: "herramienta mal escrita: sobre invalido",
    nombre: "laboratorio_malEscrita",
    argumentos: { entrada: "lo que sea" },
    esperado: false,
    claseEsperada: "sobre_invalido",
  },
];

interface SobreLeido {
  readonly ok: boolean;
  readonly clase: ClaseError | undefined;
}

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
  const objeto = analizado as { ok?: unknown; clase?: unknown };
  if (typeof objeto.ok !== "boolean") {
    return undefined;
  }
  return {
    ok: objeto.ok,
    clase: esClaseError(objeto.clase) ? objeto.clase : undefined,
  };
}

async function principal(): Promise<void> {
  let pasan = 0;

  for (const [indice, verificacion] of verificaciones.entries()) {
    const salida = await ejecutar(
      registro,
      verificacion.nombre,
      verificacion.argumentos,
    );
    const esString = typeof salida === "string";
    const sobre = leerSobre(salida);
    const pasa =
      esString &&
      sobre !== undefined &&
      sobre.ok === verificacion.esperado &&
      sobre.clase === verificacion.claseEsperada;
    if (pasa) {
      pasan += 1;
    }
    console.log(
      `${indice + 1}. ${pasa ? "PASA" : "FALLA"} - ${verificacion.titulo}`,
    );
    console.log(
      `   clase esperada: ${verificacion.claseEsperada ?? "(ninguna)"} | obtenida: ${sobre?.clase ?? "(ninguna)"}`,
    );
    console.log(`   salida: ${salida}`);
  }

  console.log("");
  console.log(`${pasan} de ${verificaciones.length} verificaciones pasan`);

  if (pasan !== verificaciones.length) {
    process.exitCode = 1;
  }
}

await principal();
