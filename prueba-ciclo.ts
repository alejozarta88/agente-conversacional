import { readFile, rm } from "node:fs/promises";
import { setTimeout as dormir } from "node:timers/promises";

import { ejecutarTurno, type ResultadoTurno } from "./src/agente/ciclo.js";
import type {
  AdaptadorProveedor,
  Mensaje,
  RespuestaProveedor,
} from "./src/llm/adapter.js";
import { ProveedorFalso, type ActoGuion } from "./src/llm/falso.js";
import {
  combinar,
  esClaseError,
  registrar,
  type ClaseError,
  type DeclaracionHerramienta,
} from "./src/tools/contrato.js";
import {
  borrar,
  eco,
  efectos,
  explotarAsync,
  fallar,
  reiniciarEfectos,
} from "./src/tools/laboratorio.js";

/**
 * Verificacion del ciclo del agente. Sin framework, sin clave, sin red.
 * Sale con codigo distinto de cero si alguna verificacion falla.
 */

/** Log propio de esta prueba: nunca toca out\log.jsonl, el de la app. */
const RUTA_LOG = "out/prueba-ciclo.jsonl";

const registro = combinar(
  registrar("laboratorio.ts", { eco, fallar, explotarAsync, borrar }),
);

const CONFIRMABLES = ["laboratorio_borrar"] as const;

function configuracion(topeIteraciones = 25) {
  return {
    topeIteraciones,
    requierenConfirmacion: CONFIRMABLES,
    rutaLog: RUTA_LOG,
  };
}

let pasan = 0;
let total = 0;
/**
 * Lo que se espera en el log, en orden, como "disposicion/clase". La clase
 * ausente se escribe "-".
 */
const esperadoEnLog: string[] = [];

/** Proveedor falso que ademas tarda, para probar el tope de tiempo. */
class ProveedorLento implements AdaptadorProveedor {
  readonly nombre = "falso-lento";

  constructor(
    private readonly interno: ProveedorFalso,
    private readonly demoraMs: number,
  ) {}

  async enviar(
    mensajes: readonly Mensaje[],
    herramientas: readonly DeclaracionHerramienta[],
  ): Promise<RespuestaProveedor> {
    await dormir(this.demoraMs);
    return this.interno.enviar(mensajes, herramientas);
  }
}

function marcar(disposicion: string, clase: ClaseError | null): string {
  return `${disposicion}/${clase ?? "-"}`;
}

function verificar(titulo: string, pasa: boolean, detalle: string): void {
  total += 1;
  if (pasa) {
    pasan += 1;
  }
  console.log(`${total}. ${pasa ? "PASA" : "FALLA"} - ${titulo}`);
  console.log(`   ${detalle}`);
}

function contarLlamadas(resultado: ResultadoTurno): void {
  for (const llamada of resultado.llamadas) {
    esperadoEnLog.push(marcar(llamada.disposicion, llamada.clase ?? null));
  }
}

/**
 * Recorre el historial y devuelve los problemas: todo tool_call emitido por
 * el asistente tiene que tener exactamente un mensaje de herramienta con su
 * id. Ni cero, que es lo que rechaza OpenAI, ni dos.
 */
function revisarHistorial(
  momento: string,
  historial: readonly Mensaje[],
): string[] {
  const respuestasPorId = new Map<string, number>();
  for (const mensaje of historial) {
    if (mensaje.rol === "herramienta") {
      respuestasPorId.set(
        mensaje.id,
        (respuestasPorId.get(mensaje.id) ?? 0) + 1,
      );
    }
  }
  const problemas: string[] = [];
  for (const mensaje of historial) {
    if (mensaje.rol !== "asistente") {
      continue;
    }
    for (const llamada of mensaje.llamadas ?? []) {
      const respuestas = respuestasPorId.get(llamada.id) ?? 0;
      if (respuestas === 0) {
        problemas.push(`${momento}: ${llamada.id} sin mensaje de herramienta`);
      } else if (respuestas > 1) {
        problemas.push(
          `${momento}: ${llamada.id} con ${respuestas} mensajes de herramienta`,
        );
      }
    }
  }
  return problemas;
}

function hayResultadoDeHerramienta(
  historial: readonly Mensaje[],
  fragmento: string,
): boolean {
  return historial.some(
    (mensaje) =>
      mensaje.rol === "herramienta" && mensaje.resultado.includes(fragmento),
  );
}

const guionUnaLlamada: readonly ActoGuion[] = [
  {
    tipo: "llamadas",
    texto: "",
    llamadas: [{ nombre: "laboratorio_eco", argumentos: { texto: "hola" } }],
  },
  { tipo: "texto", texto: "Listo: HOLA" },
];

async function principal(): Promise<void> {
  await rm(RUTA_LOG, { force: true });
  reiniciarEfectos();

  // 1. Turno sin herramientas.
  {
    const adaptador = new ProveedorFalso([
      { tipo: "texto", texto: "Hola, no necesito herramientas." },
    ]);
    const resultado = await ejecutarTurno({
      historial: [],
      mensajeUsuario: "hola",
      registro,
      adaptador,
      configuracion: configuracion(),
    });
    contarLlamadas(resultado);
    verificar(
      "turno sin herramientas: responde texto y termina",
      resultado.motivoFin === "texto" &&
        resultado.llamadas.length === 0 &&
        resultado.respuesta.startsWith("Hola") &&
        adaptador.envios === 1,
      `motivoFin=${resultado.motivoFin} llamadas=${resultado.llamadas.length} envios=${adaptador.envios}`,
    );
  }

  // 2. Una llamada a herramienta, y el resultado vuelve al modelo.
  {
    const adaptador = new ProveedorFalso(guionUnaLlamada);
    const resultado = await ejecutarTurno({
      historial: [],
      mensajeUsuario: "repite hola",
      registro,
      adaptador,
      configuracion: configuracion(),
    });
    contarLlamadas(resultado);
    const volvio = hayResultadoDeHerramienta(
      adaptador.historialDelEnvio(2),
      "HOLA",
    );
    verificar(
      "una llamada: se ejecuta y el resultado vuelve al modelo",
      resultado.motivoFin === "texto" &&
        resultado.llamadas.length === 1 &&
        resultado.llamadas[0]?.ok === true &&
        volvio,
      `llamadas=${resultado.llamadas.length} clase=${resultado.llamadas[0]?.clase ?? "(ninguna)"} elModeloViOElResultado=${volvio}`,
    );
  }

  // 3. Dos llamadas encadenadas en el mismo turno.
  {
    const adaptador = new ProveedorFalso([
      {
        tipo: "llamadas",
        texto: "",
        llamadas: [{ nombre: "laboratorio_eco", argumentos: { texto: "uno" } }],
      },
      {
        tipo: "llamadas",
        texto: "",
        llamadas: [{ nombre: "laboratorio_eco", argumentos: { texto: "dos" } }],
      },
      { tipo: "texto", texto: "UNO y DOS" },
    ]);
    const resultado = await ejecutarTurno({
      historial: [],
      mensajeUsuario: "encadena dos",
      registro,
      adaptador,
      configuracion: configuracion(),
    });
    contarLlamadas(resultado);
    verificar(
      "dos llamadas encadenadas en el mismo turno",
      resultado.motivoFin === "texto" &&
        resultado.llamadas.length === 2 &&
        adaptador.envios === 3,
      `llamadas=${resultado.llamadas.length} envios=${adaptador.envios} respuesta="${resultado.respuesta}"`,
    );
  }

  // 4. Tope de iteraciones.
  {
    const adaptador = new ProveedorFalso(
      [
        {
          tipo: "llamadas",
          texto: "sigo trabajando",
          llamadas: [
            { nombre: "laboratorio_eco", argumentos: { texto: "otra vez" } },
          ],
        },
      ],
      { alAgotar: { modo: "repetir-ultimo" } },
    );
    let lanzo = false;
    let resultado: ResultadoTurno | undefined;
    try {
      resultado = await ejecutarTurno({
        historial: [],
        mensajeUsuario: "no pares nunca",
        registro,
        adaptador,
        configuracion: configuracion(3),
      });
    } catch {
      lanzo = true;
    }
    if (resultado !== undefined) {
      contarLlamadas(resultado);
    }
    verificar(
      "tope de iteraciones: corta en el tope y responde sin lanzar",
      !lanzo &&
        resultado?.motivoFin === "tope" &&
        resultado.llamadas.length === 3 &&
        adaptador.envios === 3 &&
        resultado.respuesta.includes("tope de 3 iteraciones"),
      `lanzo=${lanzo} motivoFin=${resultado?.motivoFin} llamadas=${resultado?.llamadas.length} envios=${adaptador.envios}`,
    );
  }

  // 5. Herramienta que devuelve error legitimo.
  {
    const adaptador = new ProveedorFalso([
      {
        tipo: "llamadas",
        texto: "",
        llamadas: [
          { nombre: "laboratorio_fallar", argumentos: { causa: "disco" } },
        ],
      },
      { tipo: "texto", texto: "La herramienta fallo, sigo contigo." },
    ]);
    const resultado = await ejecutarTurno({
      historial: [],
      mensajeUsuario: "usa la que falla",
      registro,
      adaptador,
      configuracion: configuracion(),
    });
    contarLlamadas(resultado);
    const llamada = resultado.llamadas[0];
    verificar(
      "herramienta con error: el ciclo continua y el turno termina",
      resultado.motivoFin === "texto" &&
        llamada?.ok === false &&
        llamada.clase === "error_herramienta" &&
        adaptador.envios === 2,
      `motivoFin=${resultado.motivoFin} clase=${llamada?.clase} envios=${adaptador.envios}`,
    );
  }

  // 6. Herramienta que rechaza una promesa.
  {
    const adaptador = new ProveedorFalso([
      {
        tipo: "llamadas",
        texto: "",
        llamadas: [
          {
            nombre: "laboratorio_explotarAsync",
            argumentos: { motivo: "prueba" },
          },
        ],
      },
      { tipo: "texto", texto: "Contenido, sigo." },
    ]);
    let lanzo = false;
    let resultado: ResultadoTurno | undefined;
    try {
      resultado = await ejecutarTurno({
        historial: [],
        mensajeUsuario: "usa la que explota",
        registro,
        adaptador,
        configuracion: configuracion(),
      });
    } catch {
      lanzo = true;
    }
    if (resultado !== undefined) {
      contarLlamadas(resultado);
    }
    const llamada = resultado?.llamadas[0];
    verificar(
      "excepcion asincrona de herramienta: queda contenida",
      !lanzo &&
        resultado?.motivoFin === "texto" &&
        llamada?.ok === false &&
        llamada.clase === "excepcion_contenida",
      `lanzo=${lanzo} clase=${llamada?.clase} resultado=${llamada?.resultado ?? "(ninguno)"}`,
    );
  }

  // 7. Error del proveedor, y la sesion sigue utilizable.
  {
    const adaptador = new ProveedorFalso([
      { tipo: "error", mensaje: "429 sin cupo", recuperable: true, codigo: "429" },
      { tipo: "texto", texto: "Ahora si, aqui estoy." },
    ]);
    let lanzo = false;
    let primero: ResultadoTurno | undefined;
    try {
      primero = await ejecutarTurno({
        historial: [],
        mensajeUsuario: "primer intento",
        registro,
        adaptador,
        configuracion: configuracion(),
      });
    } catch {
      lanzo = true;
    }
    let segundo: ResultadoTurno | undefined;
    if (primero !== undefined) {
      contarLlamadas(primero);
      segundo = await ejecutarTurno({
        historial: primero.historial,
        mensajeUsuario: "segundo intento",
        registro,
        adaptador,
        configuracion: configuracion(),
      });
      contarLlamadas(segundo);
    }
    verificar(
      "error del proveedor: mensaje legible, no lanza, y el turno siguiente funciona",
      !lanzo &&
        primero?.motivoFin === "error-proveedor" &&
        primero.respuesta.includes("recuperable") &&
        primero.respuesta.includes("429 sin cupo") &&
        segundo?.motivoFin === "texto" &&
        segundo.respuesta === "Ahora si, aqui estoy.",
      `lanzo=${lanzo} primero="${primero?.respuesta ?? ""}" segundo="${segundo?.respuesta ?? ""}"`,
    );
  }

  // 8 y 9. Confirmacion denegada por omision, y luego concedida.
  {
    reiniciarEfectos();
    const adaptador = new ProveedorFalso([
      {
        tipo: "llamadas",
        texto: "Voy a borrar el recurso.",
        llamadas: [
          { nombre: "laboratorio_borrar", argumentos: { recurso: "informe" } },
        ],
      },
      { tipo: "texto", texto: "Recurso borrado." },
    ]);
    const primero = await ejecutarTurno({
      historial: [],
      mensajeUsuario: "borra el informe",
      registro,
      adaptador,
      configuracion: configuracion(),
    });
    contarLlamadas(primero);
    const pendiente = primero.esperandoConfirmacion;
    const anotada = primero.llamadas[0];
    verificar(
      "confirmacion pendiente: queda marcada pendiente, sin clase, y el efecto NO ocurre",
      primero.motivoFin === "confirmacion" &&
        pendiente?.llamada.nombre === "laboratorio_borrar" &&
        primero.llamadas.length === 1 &&
        anotada?.disposicion === "pendiente" &&
        anotada.clase === undefined &&
        efectos.borrados.length === 0 &&
        adaptador.envios === 1,
      `motivoFin=${primero.motivoFin} disposicion=${anotada?.disposicion ?? "(ninguna)"} clase=${anotada?.clase ?? "(ninguna)"} borrados=[${efectos.borrados.join(",")}] envios=${adaptador.envios}`,
    );

    if (pendiente === undefined) {
      verificar(
        "confirmacion concedida: el turno siguiente si la ejecuta",
        false,
        "no hubo pendiente que confirmar",
      );
    } else {
      const segundo = await ejecutarTurno({
        historial: primero.historial,
        mensajeUsuario: "",
        registro,
        adaptador,
        configuracion: configuracion(),
        confirmacion: { pendiente, aprobada: true },
      });
      contarLlamadas(segundo);
      const ejecutada = segundo.llamadas[0];
      verificar(
        "confirmacion concedida: el turno siguiente la ejecuta y queda ejecutada",
        segundo.motivoFin === "texto" &&
          segundo.llamadas.length === 1 &&
          ejecutada?.ok === true &&
          ejecutada.disposicion === "ejecutada" &&
          segundo.esperandoConfirmacion === undefined &&
          efectos.borrados.join(",") === "informe",
        `motivoFin=${segundo.motivoFin} disposicion=${ejecutada?.disposicion ?? "(ninguna)"} borrados=[${efectos.borrados.join(",")}]`,
      );
    }
  }

  // 10. Denegacion explicita.
  {
    const adaptador = new ProveedorFalso([
      {
        tipo: "llamadas",
        texto: "Voy a borrar la copia.",
        llamadas: [
          { nombre: "laboratorio_borrar", argumentos: { recurso: "respaldo" } },
        ],
      },
      { tipo: "texto", texto: "Entendido, no lo borro." },
    ]);
    const primero = await ejecutarTurno({
      historial: [],
      mensajeUsuario: "borra el respaldo",
      registro,
      adaptador,
      configuracion: configuracion(),
    });
    contarLlamadas(primero);
    const pendiente = primero.esperandoConfirmacion;

    if (pendiente === undefined) {
      verificar(
        "denegacion explicita: la herramienta NO corre y queda denegada",
        false,
        "no hubo pendiente que denegar",
      );
    } else {
      const segundo = await ejecutarTurno({
        historial: primero.historial,
        mensajeUsuario: "",
        registro,
        adaptador,
        configuracion: configuracion(),
        confirmacion: {
          pendiente,
          aprobada: false,
          motivo: "el humano dijo que no",
        },
      });
      contarLlamadas(segundo);
      const denegada = segundo.llamadas[0];
      verificar(
        "denegacion explicita: la herramienta NO corre y queda denegada sin clase",
        segundo.motivoFin === "texto" &&
          segundo.llamadas.length === 1 &&
          denegada?.disposicion === "denegada" &&
          denegada.clase === undefined &&
          denegada.ok === false &&
          !efectos.borrados.includes("respaldo"),
        `motivoFin=${segundo.motivoFin} disposicion=${denegada?.disposicion ?? "(ninguna)"} clase=${denegada?.clase ?? "(ninguna)"} borrados=[${efectos.borrados.join(",")}]`,
      );
    }
  }

  // 11. Tope de tiempo por turno.
  {
    const interno = new ProveedorFalso(
      [
        {
          tipo: "llamadas",
          texto: "voy despacio",
          llamadas: [
            { nombre: "laboratorio_eco", argumentos: { texto: "otra vez" } },
          ],
        },
      ],
      { alAgotar: { modo: "repetir-ultimo" } },
    );
    const adaptador = new ProveedorLento(interno, 60);
    let lanzo = false;
    let resultado: ResultadoTurno | undefined;
    const arranque = Date.now();
    try {
      resultado = await ejecutarTurno({
        historial: [],
        mensajeUsuario: "tarda lo que quieras",
        registro,
        adaptador,
        // Tope de iteraciones alto: el que tiene que cortar es el reloj.
        configuracion: { ...configuracion(25), topeMsPorTurno: 150 },
      });
    } catch {
      lanzo = true;
    }
    const tardo = Date.now() - arranque;
    if (resultado !== undefined) {
      contarLlamadas(resultado);
    }
    verificar(
      "tope de tiempo por turno: corta y responde sin lanzar",
      !lanzo &&
        resultado?.motivoFin === "tiempo" &&
        resultado.respuesta.includes("Se agoto el tiempo") &&
        interno.envios < 25 &&
        tardo < 2000,
      `lanzo=${lanzo} motivoFin=${resultado?.motivoFin} envios=${interno.envios} tardo=${tardo} ms`,
    );
  }

  // 12. Ningun tool_call se queda sin su mensaje de herramienta.
  {
    reiniciarEfectos();
    const problemas: string[] = [];

    // a) Turno que queda pendiente, con una segunda llamada detras.
    const adaptadorA = new ProveedorFalso([
      {
        tipo: "llamadas",
        texto: "Borro y luego repito.",
        llamadas: [
          { nombre: "laboratorio_borrar", argumentos: { recurso: "acta" } },
          { nombre: "laboratorio_eco", argumentos: { texto: "listo" } },
        ],
      },
      { tipo: "texto", texto: "Hecho." },
      { tipo: "texto", texto: "Sigo aqui." },
    ]);
    const pendienteTurno = await ejecutarTurno({
      historial: [],
      mensajeUsuario: "borra el acta y repite listo",
      registro,
      adaptador: adaptadorA,
      configuracion: configuracion(),
    });
    contarLlamadas(pendienteTurno);
    problemas.push(
      ...revisarHistorial("tras quedar pendiente", pendienteTurno.historial),
    );

    // b) El mismo pendiente, confirmado.
    const pendiente = pendienteTurno.esperandoConfirmacion;
    if (pendiente === undefined) {
      problemas.push("no hubo pendiente que confirmar");
    } else {
      const confirmado = await ejecutarTurno({
        historial: pendienteTurno.historial,
        mensajeUsuario: "",
        registro,
        adaptador: adaptadorA,
        configuracion: configuracion(),
        confirmacion: { pendiente, aprobada: true },
      });
      contarLlamadas(confirmado);
      problemas.push(
        ...revisarHistorial("tras confirmar", confirmado.historial),
      );

      // c) Un turno normal despues de haber confirmado: la secuencia que
      // reventaba contra OpenAI.
      const siguiente = await ejecutarTurno({
        historial: confirmado.historial,
        mensajeUsuario: "gracias",
        registro,
        adaptador: adaptadorA,
        configuracion: configuracion(),
      });
      contarLlamadas(siguiente);
      problemas.push(
        ...revisarHistorial("en el turno siguiente", siguiente.historial),
      );
    }

    // d) Un pendiente denegado.
    const adaptadorB = new ProveedorFalso([
      {
        tipo: "llamadas",
        texto: "Borro la copia.",
        llamadas: [
          { nombre: "laboratorio_borrar", argumentos: { recurso: "copia" } },
        ],
      },
      { tipo: "texto", texto: "No lo borro." },
    ]);
    const previo = await ejecutarTurno({
      historial: [],
      mensajeUsuario: "borra la copia",
      registro,
      adaptador: adaptadorB,
      configuracion: configuracion(),
    });
    contarLlamadas(previo);
    const paraDenegar = previo.esperandoConfirmacion;
    if (paraDenegar === undefined) {
      problemas.push("no hubo pendiente que denegar");
    } else {
      const denegado = await ejecutarTurno({
        historial: previo.historial,
        mensajeUsuario: "",
        registro,
        adaptador: adaptadorB,
        configuracion: configuracion(),
        confirmacion: {
          pendiente: paraDenegar,
          aprobada: false,
          motivo: "ni de broma",
        },
      });
      contarLlamadas(denegado);
      problemas.push(...revisarHistorial("tras denegar", denegado.historial));
    }

    verificar(
      "ningun tool_call se queda sin su mensaje de herramienta",
      problemas.length === 0,
      problemas.length === 0
        ? "historiales coherentes tras pendiente, confirmada, turno siguiente y denegada"
        : problemas.join(" | "),
    );
  }

  // 13. El log tiene una linea por llamada, con disposicion y clase.
  {
    const enLog: string[] = [];
    let lineasValidas = 0;
    let lineas = 0;
    try {
      const contenido = await readFile(RUTA_LOG, "utf8");
      const partes = contenido.split("\n").filter((linea) => linea !== "");
      lineas = partes.length;
      for (const linea of partes) {
        const campo: unknown = JSON.parse(linea);
        if (typeof campo !== "object" || campo === null) {
          enLog.push("ilegible/-");
          continue;
        }
        const registroLog = campo as Record<string, unknown>;
        if (
          typeof registroLog["ts"] === "string" &&
          typeof registroLog["herramienta"] === "string" &&
          typeof registroLog["ok"] === "boolean" &&
          typeof registroLog["resumen"] === "string"
        ) {
          lineasValidas += 1;
        }
        const clase = registroLog["clase"];
        const disposicion = registroLog["disposicion"];
        enLog.push(
          marcar(
            disposicion === "ejecutada" ||
              disposicion === "denegada" ||
              disposicion === "pendiente"
              ? disposicion
              : "ilegible",
            esClaseError(clase) ? clase : null,
          ),
        );
      }
    } catch {
      lineas = -1;
    }
    const esperadas = esperadoEnLog.join(" ");
    const obtenidas = enLog.join(" ");
    verificar(
      "out\\prueba-ciclo.jsonl: una linea por llamada, con disposicion y clase correctas",
      lineas === esperadoEnLog.length &&
        lineasValidas === lineas &&
        obtenidas === esperadas,
      `esperadas=[${esperadas}]
   obtenidas=[${obtenidas}]`,
    );
  }

  console.log("");
  console.log(`${pasan} de ${total} verificaciones pasan`);
  if (pasan !== total) {
    process.exitCode = 1;
  }
}

await principal();
