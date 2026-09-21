import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { declarar, registrar } from "./src/tools/contrato.js";
import { esErrorProveedor, type Mensaje } from "./src/llm/adapter.js";
import { eco } from "./src/tools/laboratorio.js";

/**
 * Verificacion del adaptador de OpenAI contra un servidor HTTP local que se
 * levanta aqui mismo. Sin red externa y sin clave real.
 */

const CLAVE_DE_RELLENO = "sk-de-relleno-para-pruebas-0000000000";
process.env["OPENAI_API_KEY"] = CLAVE_DE_RELLENO;

// La importacion va despues de poner la variable: el adaptador la lee al
// construirse, no al importarse, pero asi queda explicito el orden.
const { AdaptadorOpenAI } = await import("./src/llm/openai.js");

const registro = registrar("laboratorio.ts", { eco });
const declaraciones = declarar(registro);
const HISTORIAL: readonly Mensaje[] = [{ rol: "usuario", texto: "hola" }];

interface RespuestaSimulada {
  readonly estado: number;
  readonly cuerpo: string;
  readonly cabeceras?: Readonly<Record<string, string>>;
  readonly demoraMs?: number;
}

let cola: RespuestaSimulada[] = [];
let ultimaDeLaCola: RespuestaSimulada | undefined;
let peticiones = 0;
const llegadas: number[] = [];
const cuerposRecibidos: string[] = [];

/** Todo lo que se pudo leer de los errores lanzados, para la verificacion 14. */
const rastroDeErrores: string[] = [];

function anotarError(causa: unknown): void {
  if (causa instanceof Error) {
    rastroDeErrores.push(causa.message);
    rastroDeErrores.push(causa.stack ?? "");
  }
  rastroDeErrores.push(String(causa));
  try {
    rastroDeErrores.push(JSON.stringify(causa));
  } catch {
    // Un error que no se serializa no aporta rastro.
  }
}

function preparar(respuestas: readonly RespuestaSimulada[]): void {
  cola = [...respuestas];
  ultimaDeLaCola = respuestas[respuestas.length - 1];
  peticiones = 0;
  llegadas.length = 0;
  cuerposRecibidos.length = 0;
}

const servidor: Server = createServer((peticion, respuesta) => {
  peticiones += 1;
  llegadas.push(Date.now());
  let recibido = "";
  peticion.on("data", (trozo: Buffer | string) => {
    recibido += String(trozo);
  });
  peticion.on("end", () => {
    cuerposRecibidos.push(recibido);
    const simulada = cola.shift() ?? ultimaDeLaCola;
    const salida: RespuestaSimulada = simulada ?? {
      estado: 500,
      cuerpo: '{"error":{"message":"sin guion"}}',
    };
    const responder = (): void => {
      respuesta.writeHead(salida.estado, {
        "content-type": "application/json",
        ...(salida.cabeceras ?? {}),
      });
      respuesta.end(salida.cuerpo);
    };
    if (salida.demoraMs === undefined) {
      responder();
    } else {
      setTimeout(responder, salida.demoraMs);
    }
  });
});

function cuerpoTexto(texto: string): string {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content: texto } }],
  });
}

function cuerpoLlamadas(
  llamadas: readonly { id: string; nombre: string; argumentos: string }[],
): string {
  return JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: llamadas.map((llamada) => ({
            id: llamada.id,
            type: "function",
            function: { name: llamada.nombre, arguments: llamada.argumentos },
          })),
        },
      },
    ],
  });
}

const ERROR_429 = '{"error":{"message":"rate limit alcanzado"}}';

let pasan = 0;
let total = 0;

function verificar(titulo: string, pasa: boolean, detalle: string): void {
  total += 1;
  if (pasa) {
    pasan += 1;
  }
  console.log(`${total}. ${pasa ? "PASA" : "FALLA"} - ${titulo}`);
  console.log(`   ${detalle}`);
}

async function principal(): Promise<void> {
  await new Promise<void>((resolver) => {
    servidor.listen(0, "127.0.0.1", resolver);
  });
  const direccion = servidor.address() as AddressInfo;
  const urlBase = `http://127.0.0.1:${direccion.port}/v1`;

  const adaptadorRapido = (
    intentos = 3,
    esperaInicialMs = 20,
    timeoutMs = 2000,
  ) =>
    new AdaptadorOpenAI({
      urlBase,
      modelo: "modelo-de-prueba",
      intentos,
      esperaInicialMs,
      factorEspera: 2,
      timeoutMs,
    });

  // 1. Respuesta de texto.
  {
    preparar([{ estado: 200, cuerpo: cuerpoTexto("hola humano") }]);
    const respuesta = await adaptadorRapido().enviar(
      HISTORIAL,
      declaraciones,
    );
    const enviado = cuerposRecibidos[0] ?? "";
    verificar(
      "respuesta de texto: se traduce bien y las herramientas viajan",
      respuesta.tipo === "texto" &&
        respuesta.texto === "hola humano" &&
        enviado.includes("laboratorio_eco") &&
        enviado.includes('"parameters"'),
      `tipo=${respuesta.tipo} texto="${respuesta.tipo === "texto" ? respuesta.texto : ""}" herramientaEnPeticion=${enviado.includes("laboratorio_eco")}`,
    );
  }

  // 2. Una peticion de llamada.
  {
    preparar([
      {
        estado: 200,
        cuerpo: cuerpoLlamadas([
          {
            id: "call_1",
            nombre: "laboratorio_eco",
            argumentos: '{"texto":"hola"}',
          },
        ]),
      },
    ]);
    const respuesta = await adaptadorRapido().enviar(HISTORIAL, declaraciones);
    const llamada =
      respuesta.tipo === "llamadas" ? respuesta.llamadas[0] : undefined;
    verificar(
      "una peticion de llamada: nombre e id bien, argumentos ya como objeto",
      respuesta.tipo === "llamadas" &&
        respuesta.llamadas.length === 1 &&
        llamada?.nombre === "laboratorio_eco" &&
        llamada.id === "call_1" &&
        typeof llamada.argumentos === "object" &&
        llamada.argumentos !== null &&
        JSON.stringify(llamada.argumentos) === '{"texto":"hola"}',
      `nombre=${llamada?.nombre} tipoArgumentos=${typeof llamada?.argumentos} argumentos=${JSON.stringify(llamada?.argumentos)}`,
    );
  }

  // 3. Dos peticiones de llamada en el mismo mensaje.
  {
    preparar([
      {
        estado: 200,
        cuerpo: cuerpoLlamadas([
          {
            id: "call_1",
            nombre: "laboratorio_eco",
            argumentos: '{"texto":"uno"}',
          },
          {
            id: "call_2",
            nombre: "laboratorio_eco",
            argumentos: '{"texto":"dos"}',
          },
        ]),
      },
    ]);
    const respuesta = await adaptadorRapido().enviar(HISTORIAL, declaraciones);
    const nombres =
      respuesta.tipo === "llamadas"
        ? respuesta.llamadas.map((llamada) => llamada.id).join(",")
        : "";
    verificar(
      "dos peticiones de llamada en el mismo mensaje: llegan las dos",
      respuesta.tipo === "llamadas" &&
        respuesta.llamadas.length === 2 &&
        nombres === "call_1,call_2",
      `llamadas=${respuesta.tipo === "llamadas" ? respuesta.llamadas.length : 0} ids=[${nombres}]`,
    );
  }

  // 4. Argumentos que no son JSON valido.
  {
    preparar([
      {
        estado: 200,
        cuerpo: cuerpoLlamadas([
          {
            id: "call_1",
            nombre: "laboratorio_eco",
            argumentos: '{"texto": no es json',
          },
        ]),
      },
    ]);
    let lanzo = false;
    let argumentos: unknown;
    let tipo = "";
    try {
      const respuesta = await adaptadorRapido().enviar(
        HISTORIAL,
        declaraciones,
      );
      tipo = respuesta.tipo;
      argumentos =
        respuesta.tipo === "llamadas"
          ? respuesta.llamadas[0]?.argumentos
          : undefined;
    } catch (causa: unknown) {
      lanzo = true;
      anotarError(causa);
    }
    verificar(
      "argumentos con JSON invalido: no revienta, viaja el string crudo",
      !lanzo &&
        tipo === "llamadas" &&
        typeof argumentos === "string" &&
        argumentos === '{"texto": no es json',
      `lanzo=${lanzo} tipo=${tipo} tipoArgumentos=${typeof argumentos}`,
    );
  }

  // 5. 429 y luego exito.
  {
    preparar([
      { estado: 429, cuerpo: ERROR_429 },
      { estado: 200, cuerpo: cuerpoTexto("a la segunda") },
    ]);
    const respuesta = await adaptadorRapido().enviar(HISTORIAL, declaraciones);
    verificar(
      "429 y luego exito: reintenta y termina bien",
      respuesta.tipo === "texto" &&
        respuesta.texto === "a la segunda" &&
        peticiones === 2,
      `peticiones=${peticiones} texto="${respuesta.tipo === "texto" ? respuesta.texto : ""}"`,
    );
  }

  // 6. 503 y luego exito.
  {
    preparar([
      { estado: 503, cuerpo: '{"error":{"message":"no disponible"}}' },
      { estado: 200, cuerpo: cuerpoTexto("recuperado") },
    ]);
    const respuesta = await adaptadorRapido().enviar(HISTORIAL, declaraciones);
    verificar(
      "503 y luego exito: reintenta y termina bien",
      respuesta.tipo === "texto" &&
        respuesta.texto === "recuperado" &&
        peticiones === 2,
      `peticiones=${peticiones} texto="${respuesta.tipo === "texto" ? respuesta.texto : ""}"`,
    );
  }

  // 7. 429 sostenido.
  {
    preparar([{ estado: 429, cuerpo: ERROR_429 }]);
    let recuperable: boolean | undefined;
    let codigo = "";
    try {
      await adaptadorRapido().enviar(HISTORIAL, declaraciones);
    } catch (causa: unknown) {
      anotarError(causa);
      if (esErrorProveedor(causa)) {
        recuperable = causa.recuperable;
        codigo = causa.codigo;
      }
    }
    verificar(
      "429 sostenido: agota los reintentos y lanza recuperable",
      recuperable === true && codigo === "http_429" && peticiones === 3,
      `recuperable=${String(recuperable)} codigo=${codigo} peticiones=${peticiones}`,
    );
  }

  // 8. 401: no se reintenta.
  {
    preparar([{ estado: 401, cuerpo: '{"error":{"message":"clave invalida"}}' }]);
    let recuperable: boolean | undefined;
    let codigo = "";
    try {
      await adaptadorRapido().enviar(HISTORIAL, declaraciones);
    } catch (causa: unknown) {
      anotarError(causa);
      if (esErrorProveedor(causa)) {
        recuperable = causa.recuperable;
        codigo = causa.codigo;
      }
    }
    verificar(
      "401: no reintenta, el servidor recibe UNA sola peticion",
      recuperable === false && codigo === "http_401" && peticiones === 1,
      `recuperable=${String(recuperable)} codigo=${codigo} peticiones=${peticiones}`,
    );
  }

  // 9. 400: no se reintenta.
  {
    preparar([{ estado: 400, cuerpo: '{"error":{"message":"peticion mala"}}' }]);
    let recuperable: boolean | undefined;
    try {
      await adaptadorRapido().enviar(HISTORIAL, declaraciones);
    } catch (causa: unknown) {
      anotarError(causa);
      if (esErrorProveedor(causa)) {
        recuperable = causa.recuperable;
      }
    }
    verificar(
      "400: no reintenta",
      recuperable === false && peticiones === 1,
      `recuperable=${String(recuperable)} peticiones=${peticiones}`,
    );
  }

  // 10. Timeout.
  {
    preparar([
      { estado: 200, cuerpo: cuerpoTexto("tarde"), demoraMs: 400 },
    ]);
    let recuperable: boolean | undefined;
    let codigo = "";
    try {
      await adaptadorRapido(1, 20, 80).enviar(HISTORIAL, declaraciones);
    } catch (causa: unknown) {
      anotarError(causa);
      if (esErrorProveedor(causa)) {
        recuperable = causa.recuperable;
        codigo = causa.codigo;
      }
    }
    verificar(
      "timeout: se corta la peticion y el error es recuperable",
      recuperable === true && codigo === "timeout",
      `recuperable=${String(recuperable)} codigo=${codigo}`,
    );
  }

  // 11. Cuerpo con JSON malformado.
  {
    preparar([{ estado: 200, cuerpo: "{{{esto no es json" }]);
    let recuperable: boolean | undefined;
    let codigo = "";
    try {
      await adaptadorRapido(1).enviar(HISTORIAL, declaraciones);
    } catch (causa: unknown) {
      anotarError(causa);
      if (esErrorProveedor(causa)) {
        recuperable = causa.recuperable;
        codigo = causa.codigo;
      }
    }
    verificar(
      "cuerpo con JSON malformado: no recuperable y sin colgarse",
      recuperable === false && codigo === "respuesta_ilegible",
      `recuperable=${String(recuperable)} codigo=${codigo}`,
    );
  }

  // 12. Cabecera de espera.
  {
    preparar([
      {
        estado: 429,
        cuerpo: ERROR_429,
        cabeceras: { "retry-after-ms": "300" },
      },
      { estado: 200, cuerpo: cuerpoTexto("respetada") },
    ]);
    // La espera calculada seria de 20 ms: si se respeta la cabecera, pasan 300.
    await adaptadorRapido(3, 20).enviar(HISTORIAL, declaraciones);
    const primera = llegadas[0] ?? 0;
    const segunda = llegadas[1] ?? 0;
    const hueco = segunda - primera;
    verificar(
      "cabecera de espera: se respeta en vez de la espera calculada",
      peticiones === 2 && hueco >= 280,
      `hueco=${hueco} ms (calculada habria sido 20 ms)`,
    );
  }

  // 13. La espera crece.
  {
    preparar([
      { estado: 429, cuerpo: ERROR_429 },
      { estado: 429, cuerpo: ERROR_429 },
      { estado: 429, cuerpo: ERROR_429 },
      { estado: 200, cuerpo: cuerpoTexto("por fin") },
    ]);
    await adaptadorRapido(4, 80).enviar(HISTORIAL, declaraciones);
    const huecos: number[] = [];
    for (let i = 1; i < llegadas.length; i += 1) {
      huecos.push((llegadas[i] ?? 0) - (llegadas[i - 1] ?? 0));
    }
    const [primero = 0, segundo = 0, tercero = 0] = huecos;
    verificar(
      "la espera entre reintentos crece",
      peticiones === 4 &&
        huecos.length === 3 &&
        segundo > primero * 1.4 &&
        tercero > segundo * 1.4,
      `huecos=[${huecos.join(", ")}] ms (esperado del orden de 80, 160, 320)`,
    );
  }

  // 14. La clave no aparece en ningun error.
  {
    const adaptador = adaptadorRapido();
    let serializado = "";
    try {
      serializado = JSON.stringify(adaptador) ?? "";
    } catch {
      serializado = "(no serializable)";
    }
    const fragmento = CLAVE_DE_RELLENO.slice(0, 12);
    const filtrada = rastroDeErrores.some(
      (linea) => linea.includes(CLAVE_DE_RELLENO) || linea.includes(fragmento),
    );
    verificar(
      "la clave no aparece en el mensaje de ningun error ni en el adaptador",
      !filtrada &&
        !serializado.includes(CLAVE_DE_RELLENO) &&
        !serializado.includes(fragmento) &&
        rastroDeErrores.length > 0,
      `rastrosRevisados=${rastroDeErrores.length} apareceEnErrores=${filtrada} adaptadorSerializado=${serializado}`,
    );
  }

  servidor.closeAllConnections();
  await new Promise<void>((resolver) => {
    servidor.close(() => {
      resolver();
    });
  });

  console.log("");
  console.log(`${pasan} de ${total} verificaciones pasan`);
  if (pasan !== total) {
    process.exitCode = 1;
  }
}

await principal();
