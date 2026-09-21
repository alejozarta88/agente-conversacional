import { readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { setTimeout as dormir } from "node:timers/promises";

import type {
  AdaptadorProveedor,
  Mensaje,
  RespuestaProveedor,
} from "./src/llm/adapter.js";
import { ProveedorFalso, type ActoGuion } from "./src/llm/falso.js";
import { crearServidor, type Limites } from "./src/server.js";
import {
  registrar,
  type DeclaracionHerramienta,
} from "./src/tools/contrato.js";
import {
  borrar,
  eco,
  efectos,
  reiniciarEfectos,
} from "./src/tools/laboratorio.js";

/**
 * Verificacion del servidor con el proveedor FALSO inyectado.
 * Sin clave real, sin red externa: todo contra 127.0.0.1.
 */

const CLAVE_DE_RELLENO = "sk-de-relleno-para-pruebas-0000000000";
process.env["OPENAI_API_KEY"] = CLAVE_DE_RELLENO;

/** Log propio de esta prueba: nunca toca out\log.jsonl, el de la app. */
const RUTA_LOG = "out/prueba-servidor.jsonl";

const registro = registrar("laboratorio.ts", { eco, borrar });

/** Permite cambiar el guion del proveedor falso entre verificaciones. */
class Conmutador implements AdaptadorProveedor {
  readonly nombre = "falso";
  actual: ProveedorFalso = new ProveedorFalso([
    { tipo: "texto", texto: "sin guion" },
  ]);

  async enviar(
    mensajes: readonly Mensaje[],
    herramientas: readonly DeclaracionHerramienta[],
  ): Promise<RespuestaProveedor> {
    return this.actual.enviar(mensajes, herramientas);
  }
}

const conmutador = new Conmutador();

function guion(actos: readonly ActoGuion[]): void {
  conmutador.actual = new ProveedorFalso(actos);
}

/** Responde siempre lo mismo, para pruebas con varias sesiones seguidas. */
function guionFijo(texto: string): void {
  conmutador.actual = new ProveedorFalso([{ tipo: "texto", texto }], {
    alAgotar: { modo: "texto", texto },
  });
}

const CONFIGURACION_CICLO = {
  topeIteraciones: 10,
  requierenConfirmacion: ["laboratorio_borrar"],
  rutaLog: RUTA_LOG,
};

const servidor = crearServidor({
  adaptador: conmutador,
  registro,
  configuracionCiclo: CONFIGURACION_CICLO,
  limites: {
    mensajesPorSesion: 2,
    sesionesSimultaneas: 10,
    bytesCuerpo: 4096,
    caracteresMensaje: 200,
  },
});

/** Servidor extra con sus propios limites, para las pruebas de capacidad. */
async function levantarExtra(
  limites: Limites,
): Promise<{ base: string; cerrar: () => Promise<void>; servidor: Server }> {
  const extra = crearServidor({
    adaptador: conmutador,
    registro,
    configuracionCiclo: CONFIGURACION_CICLO,
    limites,
  });
  await new Promise<void>((resolver) => {
    extra.listen(0, "127.0.0.1", resolver);
  });
  const direccion = extra.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${direccion.port}`,
    servidor: extra,
    cerrar: async (): Promise<void> => {
      extra.closeAllConnections();
      await new Promise<void>((resolver) => {
        extra.close(() => {
          resolver();
        });
      });
    },
  };
}

interface EventoVisto {
  readonly tipo: string;
  readonly texto?: string;
  readonly nombre?: string;
  readonly ok?: boolean;
  readonly disposicion?: string;
  readonly resumen?: string;
  readonly argumentos?: unknown;
}

interface VistaVista {
  readonly sesionId?: string;
  readonly eventos?: readonly EventoVisto[];
  readonly esperandoConfirmacion?: {
    nombre: string;
    argumentos: unknown;
  } | null;
  readonly mensajesUsados?: number;
  readonly mensajesPorSesion?: number;
  readonly error?: string;
  readonly sesiones?: number;
}

interface RespuestaHttp {
  readonly estado: number;
  readonly texto: string;
  readonly vista: VistaVista;
}

let base = "";

async function pedirEn(
  raiz: string,
  ruta: string,
  cuerpo?: Record<string, unknown>,
): Promise<RespuestaHttp> {
  const respuesta = await fetch(`${raiz}${ruta}`, {
    method: cuerpo === undefined ? "GET" : "POST",
    ...(cuerpo === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(cuerpo),
        }),
  });
  const texto = await respuesta.text();
  let vista: VistaVista = {};
  try {
    vista = JSON.parse(texto) as VistaVista;
  } catch {
    vista = {};
  }
  return { estado: respuesta.status, texto, vista };
}

async function pedir(
  ruta: string,
  cuerpo?: Record<string, unknown>,
): Promise<RespuestaHttp> {
  return pedirEn(base, ruta, cuerpo);
}

function ultimoTexto(vista: VistaVista, tipo: string): string {
  const eventos = (vista.eventos ?? []).filter(
    (evento) => evento.tipo === tipo,
  );
  return eventos[eventos.length - 1]?.texto ?? "";
}

/** Todo tool_call del historial tiene que tener su mensaje de herramienta. */
function revisarHistorial(historial: readonly Mensaje[]): string[] {
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
      if (respuestas !== 1) {
        problemas.push(`${llamada.id} con ${respuestas} respuestas`);
      }
    }
  }
  return problemas;
}

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

const TEXTO_SIMPLE: readonly ActoGuion[] = [
  { tipo: "texto", texto: "Hola, soy el agente." },
];

const GUION_BORRAR: readonly ActoGuion[] = [
  {
    tipo: "llamadas",
    texto: "Voy a borrar eso.",
    llamadas: [
      { nombre: "laboratorio_borrar", argumentos: { recurso: "informe" } },
    ],
  },
  { tipo: "texto", texto: "Hecho." },
];

async function principal(): Promise<void> {
  await new Promise<void>((resolver) => {
    servidor.listen(0, "127.0.0.1", resolver);
  });
  const direccion = servidor.address() as AddressInfo;
  base = `http://127.0.0.1:${direccion.port}`;
  await rm(RUTA_LOG, { force: true });
  reiniciarEfectos();

  // 1 y 2. Salud.
  {
    const salud = await pedir("/api/health");
    verificar(
      "/api/health responde 200",
      salud.estado === 200,
      `estado=${salud.estado} cuerpo=${salud.texto}`,
    );
    verificar(
      "/api/health no contiene la cadena de la clave",
      !salud.texto.includes(CLAVE_DE_RELLENO) &&
        !salud.texto.includes(CLAVE_DE_RELLENO.slice(0, 12)),
      `cuerpo=${salud.texto}`,
    );
  }

  // 3. Mensaje simple. El servidor emite el identificador.
  let idSimple = "";
  {
    guion(TEXTO_SIMPLE);
    const respuesta = await pedir("/api/chat", { mensaje: "hola" });
    idSimple = respuesta.vista.sesionId ?? "";
    verificar(
      "POST /api/chat sin sesionId crea la sesion y devuelve texto",
      respuesta.estado === 200 &&
        idSimple.length >= 32 &&
        ultimoTexto(respuesta.vista, "agente") === "Hola, soy el agente." &&
        respuesta.vista.mensajesUsados === 1,
      `estado=${respuesta.estado} sesionId=${idSimple} agente="${ultimoTexto(respuesta.vista, "agente")}"`,
    );
  }

  // 4. Historial de la sesion.
  {
    const respuesta = await pedir(`/api/sessions/${idSimple}`);
    const tipos = (respuesta.vista.eventos ?? [])
      .map((evento) => evento.tipo)
      .join(",");
    verificar(
      "GET /api/sessions/:id devuelve el historial de esa sesion",
      respuesta.estado === 200 &&
        respuesta.vista.sesionId === idSimple &&
        tipos === "usuario,agente",
      `estado=${respuesta.estado} eventos=[${tipos}]`,
    );
  }

  // 5. Dos sesiones no se mezclan.
  {
    guion([{ tipo: "texto", texto: "Soy la segunda sesion." }]);
    const otra = await pedir("/api/chat", { mensaje: "buenas" });
    const idOtra = otra.vista.sesionId ?? "";
    const primera = await pedir(`/api/sessions/${idSimple}`);
    const segunda = await pedir(`/api/sessions/${idOtra}`);
    verificar(
      "dos sesiones distintas no se mezclan",
      idOtra !== idSimple &&
        (primera.vista.eventos ?? []).length === 2 &&
        (segunda.vista.eventos ?? []).length === 2 &&
        ultimoTexto(primera.vista, "agente") === "Hola, soy el agente." &&
        ultimoTexto(segunda.vista, "agente") === "Soy la segunda sesion.",
      `primera="${ultimoTexto(primera.vista, "agente")}" segunda="${ultimoTexto(segunda.vista, "agente")}"`,
    );
  }

  // 6 y 7. Confirmacion pendiente y concedida.
  {
    reiniciarEfectos();
    guion(GUION_BORRAR);
    const primero = await pedir("/api/chat", { mensaje: "borra el informe" });
    const idConfirmar = primero.vista.sesionId ?? "";
    const pendiente = primero.vista.esperandoConfirmacion ?? null;
    const tarjeta = (primero.vista.eventos ?? []).filter(
      (evento) => evento.tipo === "herramienta",
    )[0];
    verificar(
      "un turno que pide confirmacion devuelve el pendiente y NO ejecuta",
      primero.estado === 200 &&
        pendiente?.nombre === "laboratorio_borrar" &&
        efectos.borrados.length === 0 &&
        tarjeta?.disposicion === "pendiente",
      `pendiente=${pendiente?.nombre ?? "(ninguno)"} borrados=[${efectos.borrados.join(",")}] disposicion=${tarjeta?.disposicion ?? "(ninguna)"}`,
    );

    const segundo = await pedir("/api/chat", {
      sesionId: idConfirmar,
      confirmacion: { aprobada: true },
    });
    const ejecutada = (segundo.vista.eventos ?? []).filter(
      (evento) =>
        evento.tipo === "herramienta" && evento.disposicion === "ejecutada",
    );
    verificar(
      "la confirmacion aprobada en el turno siguiente SI la ejecuta",
      segundo.estado === 200 &&
        efectos.borrados.join(",") === "informe" &&
        ejecutada.length === 1 &&
        segundo.vista.esperandoConfirmacion === null,
      `borrados=[${efectos.borrados.join(",")}] ejecutadas=${ejecutada.length}`,
    );
  }

  // 8. Confirmacion denegada.
  {
    reiniciarEfectos();
    guion([
      {
        tipo: "llamadas",
        texto: "Voy a borrar el respaldo.",
        llamadas: [
          { nombre: "laboratorio_borrar", argumentos: { recurso: "respaldo" } },
        ],
      },
      { tipo: "texto", texto: "De acuerdo, no lo borro." },
    ]);
    const primero = await pedir("/api/chat", { mensaje: "borra el respaldo" });
    const respuesta = await pedir("/api/chat", {
      sesionId: primero.vista.sesionId ?? "",
      confirmacion: { aprobada: false, motivo: "no quiero" },
    });
    const denegadas = (respuesta.vista.eventos ?? []).filter(
      (evento) => evento.disposicion === "denegada",
    );
    verificar(
      "la confirmacion denegada NO la ejecuta",
      respuesta.estado === 200 &&
        !efectos.borrados.includes("respaldo") &&
        denegadas.length === 1 &&
        respuesta.vista.esperandoConfirmacion === null,
      `borrados=[${efectos.borrados.join(",")}] denegadas=${denegadas.length}`,
    );
  }

  // 9. Tope de mensajes por sesion.
  {
    guionFijo("vale");
    const primera = await pedir("/api/chat", { mensaje: "uno" });
    const idTope = primera.vista.sesionId ?? "";
    await pedir("/api/chat", { sesionId: idTope, mensaje: "dos" });
    const tercera = await pedir("/api/chat", {
      sesionId: idTope,
      mensaje: "tres",
    });
    const aviso = ultimoTexto(tercera.vista, "aviso");
    verificar(
      "el tope de mensajes por sesion corta con mensaje claro",
      tercera.estado === 200 &&
        aviso.includes("tope de 2 mensajes") &&
        tercera.vista.mensajesUsados === 2,
      `estado=${tercera.estado} aviso="${aviso}"`,
    );
  }

  // 10. Error del proveedor.
  {
    guion([
      { tipo: "error", mensaje: "503 sin servicio", recuperable: true },
      { tipo: "texto", texto: "Ya estoy de vuelta." },
    ]);
    const fallida = await pedir("/api/chat", { mensaje: "hola" });
    const idFallo = fallida.vista.sesionId ?? "";
    const error = ultimoTexto(fallida.vista, "error");
    const siguiente = await pedir("/api/chat", {
      sesionId: idFallo,
      mensaje: "y ahora",
    });
    verificar(
      "un error del proveedor devuelve 200 con el error dentro y la sesion sigue usable",
      fallida.estado === 200 &&
        error.includes("503 sin servicio") &&
        !error.includes(CLAVE_DE_RELLENO) &&
        siguiente.estado === 200 &&
        ultimoTexto(siguiente.vista, "agente") === "Ya estoy de vuelta.",
      `estado=${fallida.estado} error="${error}" segundoTurno="${ultimoTexto(siguiente.vista, "agente")}"`,
    );
  }

  // 11. La secuencia que reventaba contra OpenAI.
  {
    reiniciarEfectos();
    guion([
      {
        tipo: "llamadas",
        texto: "Voy a borrar el acta.",
        llamadas: [
          { nombre: "laboratorio_borrar", argumentos: { recurso: "acta" } },
        ],
      },
      { tipo: "texto", texto: "Acta borrada." },
      { tipo: "texto", texto: "Aqui sigo, dime." },
    ]);
    const primero = await pedir("/api/chat", { mensaje: "borra el acta" });
    const idSecuencia = primero.vista.sesionId ?? "";
    await pedir("/api/chat", {
      sesionId: idSecuencia,
      confirmacion: { aprobada: true },
    });
    const tercero = await pedir("/api/chat", {
      sesionId: idSecuencia,
      mensaje: "y ahora que",
    });
    const problemas = revisarHistorial(conmutador.actual.ultimoHistorial);
    verificar(
      "pedir confirmacion, confirmar y un tercer turno normal: funciona",
      tercero.estado === 200 &&
        ultimoTexto(tercero.vista, "agente") === "Aqui sigo, dime." &&
        efectos.borrados.join(",") === "acta" &&
        problemas.length === 0,
      `estado=${tercero.estado} agente="${ultimoTexto(tercero.vista, "agente")}" borrados=[${efectos.borrados.join(",")}] historial=${problemas.length === 0 ? "coherente" : problemas.join("; ")}`,
    );
  }

  // 12. El prompt real entra como mensaje de sistema.
  {
    const enDisco = (await readFile("agent/prompt.md", "utf8")).trim();
    guionFijo("listo");
    await pedir("/api/chat", { mensaje: "hola" });
    const primero = conmutador.actual.historialDelEnvio(1)[0];
    const llegoComoSistema =
      primero?.rol === "sistema" && primero.texto === enDisco;

    const minusculas = enDisco.toLowerCase();
    const palabrasProhibidas = ["confirmacion", "confirmar", "permiso"].filter(
      (palabra) => minusculas.includes(palabra),
    );
    const ordenesProhibidas = [
      "pide confirmacion",
      "pide permiso",
      "pedir permiso",
      "pregunta antes",
      "espera su respuesta",
      "solicita autorizacion",
      "consulta antes de",
    ].filter((orden) => minusculas.includes(orden));
    const faltan = ["llama a la herramienta", "no pidas"].filter(
      (exigida) => !minusculas.includes(exigida),
    );

    verificar(
      "el prompt del archivo entra como mensaje de sistema y no negocia permisos",
      llegoComoSistema &&
        palabrasProhibidas.length === 0 &&
        ordenesProhibidas.length === 0 &&
        faltan.length === 0,
      `comoSistema=${llegoComoSistema} palabras=[${palabrasProhibidas.join(",")}] ordenes=[${ordenesProhibidas.join(",")}] faltan=[${faltan.join(",")}]`,
    );
  }

  // 13. Una sesion caducada se purga y deja sitio.
  {
    guionFijo("hola");
    const extra = await levantarExtra({
      sesionesSimultaneas: 2,
      inactividadMs: 120,
      mensajesPorSesion: 5,
    });
    await pedirEn(extra.base, "/api/chat", { mensaje: "primera" });
    await pedirEn(extra.base, "/api/chat", { mensaje: "segunda" });
    const lleno = await pedirEn(extra.base, "/api/health");
    await dormir(220);
    const tercera = await pedirEn(extra.base, "/api/chat", {
      mensaje: "tercera",
    });
    const despues = await pedirEn(extra.base, "/api/health");
    await extra.cerrar();
    verificar(
      "una sesion caducada se purga y deja sitio a la siguiente",
      lleno.vista.sesiones === 2 &&
        tercera.estado === 200 &&
        ultimoTexto(tercera.vista, "agente") === "hola" &&
        despues.vista.sesiones === 1,
      `antes=${lleno.vista.sesiones} despues=${despues.vista.sesiones} estado=${tercera.estado}`,
    );
  }

  // 14. Con el tope lleno y nada caducado, se expulsa la mas antigua.
  {
    guionFijo("hola");
    const extra = await levantarExtra({
      sesionesSimultaneas: 2,
      inactividadMs: 60_000,
      mensajesPorSesion: 5,
    });
    const primera = await pedirEn(extra.base, "/api/chat", {
      mensaje: "primera",
    });
    const idPrimera = primera.vista.sesionId ?? "";
    const segunda = await pedirEn(extra.base, "/api/chat", {
      mensaje: "segunda",
    });
    const idSegunda = segunda.vista.sesionId ?? "";
    const tercera = await pedirEn(extra.base, "/api/chat", {
      mensaje: "tercera",
    });
    const buscarPrimera = await pedirEn(
      extra.base,
      `/api/sessions/${idPrimera}`,
    );
    const buscarSegunda = await pedirEn(
      extra.base,
      `/api/sessions/${idSegunda}`,
    );
    const salud = await pedirEn(extra.base, "/api/health");
    await extra.cerrar();
    verificar(
      "con el tope lleno se expulsa la mas antigua y el que llega es atendido",
      tercera.estado === 200 &&
        ultimoTexto(tercera.vista, "agente") === "hola" &&
        buscarPrimera.estado === 404 &&
        buscarSegunda.estado === 200 &&
        salud.vista.sesiones === 2,
      `tercera=${tercera.estado} masAntigua=${buscarPrimera.estado} otra=${buscarSegunda.estado} sesiones=${salud.vista.sesiones}`,
    );
  }

  // 15. Un sesionId que el servidor no emitio se rechaza.
  {
    guionFijo("no deberia responder");
    const antes = await pedir("/api/health");
    const respuesta = await pedir("/api/chat", {
      sesionId: "inventado-por-el-cliente",
      mensaje: "hola",
    });
    const despues = await pedir("/api/health");
    verificar(
      "un sesionId no emitido por el servidor se rechaza y no crea sesion",
      respuesta.estado === 404 &&
        (respuesta.vista.error ?? "").includes("no existe o ha caducado") &&
        antes.vista.sesiones === despues.vista.sesiones,
      `estado=${respuesta.estado} error="${respuesta.vista.error ?? ""}" sesiones=${antes.vista.sesiones}->${despues.vista.sesiones}`,
    );
  }

  // 16. Cuerpo mayor que el tope de bytes.
  {
    const respuesta = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mensaje: "x".repeat(6000) }),
    });
    const texto = await respuesta.text();
    let error = "";
    try {
      error = (JSON.parse(texto) as VistaVista).error ?? "";
    } catch {
      error = "";
    }
    verificar(
      "un cuerpo mayor que el limite se rechaza con mensaje claro",
      respuesta.status === 413 &&
        error.includes("demasiado grande") &&
        error.includes("4096"),
      `estado=${respuesta.status} error="${error}"`,
    );
  }

  // 17. Mensaje mas largo que el tope de caracteres.
  {
    guionFijo("no deberia responder");
    const respuesta = await pedir("/api/chat", { mensaje: "y".repeat(300) });
    verificar(
      "un mensaje mas largo que el limite se rechaza con mensaje claro",
      respuesta.estado === 400 &&
        (respuesta.vista.error ?? "").includes("300 caracteres") &&
        (respuesta.vista.error ?? "").includes("200"),
      `estado=${respuesta.estado} error="${respuesta.vista.error ?? ""}"`,
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
