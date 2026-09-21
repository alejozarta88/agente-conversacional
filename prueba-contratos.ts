import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { combinar, declarar, ejecutar, registrar } from "./src/tools/contrato.js";
import { camposDeArgumentos, ejecutarTurno } from "./src/agente/ciclo.js";
import { ProveedorFalso } from "./src/llm/falso.js";
import { EXIGEN_APROBACION, REGISTRO_AGENTE } from "./src/registro.js";
import * as contratos from "./src/tools/contratos.js";
import {
  CORTE_REVISION,
  NOMBRES_CAMPO,
  extraerDeMensaje,
  leerMaestro,
  leerProcesadosDeDisco,
  marcarProcesado,
  similitud,
  soloCambios,
  soloConflictos,
  UMBRAL_SIMILITUD,
  validarExtraccion,
  validarFilaContraEsquema,
  type Campo,
  type Diferencia,
  type Extraccion,
  type FilaMaestro,
  type NombreCampo,
  type Validacion,
} from "./src/tools/contratos.js";

/**
 * Verificacion de las cinco herramientas del reto 02, del cableado del
 * agente y de los invariantes de escritura.
 * Sin framework, sin clave, sin red. Corre contra los fixtures reales.
 * Sale con codigo distinto de cero si alguna verificacion falla.
 */

const registro = combinar(
  registrar("contratos.ts", {
    leer_buzon: contratos.leer_buzon,
    extraer: contratos.extraer,
    validar: contratos.validar,
    registrar: contratos.registrar,
    alertas: contratos.alertas,
  }),
);

const RUTA_MAESTRO = join("fixtures", "reto-02", "maestro-contratos.csv");
const RUTA_PROCESADOS = join("out", "procesados.json");
const RAIZ_SHAREPOINT = join("out", "sharepoint");
const RUTA_COPIA = join(RAIZ_SHAREPOINT, "maestro-contratos.csv");
const RUTA_HISTORIAL = join(RAIZ_SHAREPOINT, "historial.jsonl");
const RUTA_ALERTAS = join("out", "alertas.md");
const IDS = ["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"];
const HOY = "2026-09-03";

/**
 * Huella del fixture ANTES de que corra nada. La ultima verificacion la
 * compara con la del final: el fixture debe salir identico de toda la
 * suite, incluidas las escrituras de contratos_registrar.
 */
const HUELLA_FIXTURES_INICIAL = huella("fixtures");

/**
 * contratos_registrar escribe, asi que la suite parte de cero. Esto lo
 * borra el arnes de pruebas, no ninguna herramienta.
 */
function limpiarSalida(): void {
  rmSync(RAIZ_SHAREPOINT, { recursive: true, force: true });
  rmSync(RUTA_PROCESADOS, { force: true });
  rmSync(RUTA_ALERTAS, { force: true });
}

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

interface Resultado {
  pasa: boolean;
  detalle: string;
}

interface Verificacion {
  titulo: string;
  correr: () => Promise<Resultado> | Resultado;
}

const sobreOk = z.object({ ok: z.literal(true), data: z.unknown() });

async function invocar(nombre: string, argumentos: unknown): Promise<unknown> {
  const crudo = await ejecutar(registro, nombre, argumentos);
  const analizado = sobreOk.safeParse(JSON.parse(crudo));
  if (!analizado.success) {
    throw new Error(`la herramienta ${nombre} no devolvio ok:true -> ${crudo}`);
  }
  return analizado.data.data;
}

const sobreCualquiera = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

/** Para los casos en que se espera el sobre de error. */
async function invocarCrudo(
  nombre: string,
  argumentos: unknown,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const crudo = await ejecutar(registro, nombre, argumentos);
  return sobreCualquiera.parse(JSON.parse(crudo));
}

const esquemaRegistro = z.object({
  mensaje_id: z.string(),
  id_contrato: z.string().nullable(),
  accion: z.enum([
    "nuevo",
    "actualizacion",
    "rechazado",
    "duplicado",
    "ya_procesado",
  ]),
  ruta_archivo: z.string().nullable(),
  archivado: z
    .object({ anio: z.string(), origen: z.string(), explicacion: z.string() })
    .nullable(),
  comercial: z.string(),
  comercial_resuelto: z.boolean(),
  estado_poliza: z.string(),
  escrituras: z.array(z.string()),
  aviso: z.string().nullable(),
  correcciones: z.array(
    z.object({
      campo: z.string(),
      valor: z.union([z.string(), z.number(), z.boolean()]),
    }),
  ),
  correcciones_ignoradas: z.array(z.string()),
  revision_sin_corregir: z.array(z.string()),
  procedencia: z.record(z.string(), z.string()),
  resumen_procedencia: z.string(),
});

type Correcciones = Readonly<Record<string, string | number | boolean>>;

/** El comprobante que contratos_validar emite ahora mismo para ese mensaje. */
function comprobanteVivo(mensajeId: string): string {
  return validacion(mensajeId).comprobante;
}

async function registrarMensaje(
  mensajeId: string,
  confirmado: boolean,
  correcciones?: Correcciones,
): Promise<z.infer<typeof esquemaRegistro>> {
  return esquemaRegistro.parse(
    await invocar("contratos_registrar", {
      mensaje_id: mensajeId,
      confirmado,
      hoy: HOY,
      comprobante: comprobanteVivo(mensajeId),
      ...(correcciones === undefined ? {} : { correcciones }),
    }),
  );
}

/**
 * Fila del maestro copiado. Se lee con el parser del modulo porque el
 * objeto extraido lleva comas y va entrecomillado: partir por "," a mano
 * rompe la fila. Que el CSV escrito se relea bien es parte de lo que se
 * verifica aqui.
 */
function filaCopia(idContrato: string): FilaMaestro | null {
  if (!existsSync(RUTA_COPIA)) {
    return null;
  }
  const maestro = leerMaestro();
  return maestro.filas.find((fila) => fila.id_contrato === idContrato) ?? null;
}

const esquemaAlertas = z.object({
  hoy: z.string(),
  ruta: z.string(),
  fuente_maestro: z.string(),
  ventana_dias: z.number(),
  vencidos: z.array(z.object({ id_contrato: z.string(), dias: z.number() })),
  vencen: z.array(z.object({ id_contrato: z.string(), dias: z.number() })),
  polizas_pendientes: z.array(
    z.object({ id_contrato: z.string(), estado_poliza: z.string() }),
  ),
  registrados_desde_corte: z.array(z.object({ id_contrato: z.string() })),
  remitentes_no_resueltos: z.array(
    z.object({ email: z.string(), origen: z.string(), detalle: z.string() }),
  ),
  sin_fecha_fin: z.array(z.string()),
  total_alertas: z.number(),
  resumen: z.string(),
});

async function correrAlertas(
  hoy: string,
): Promise<z.infer<typeof esquemaAlertas>> {
  return esquemaAlertas.parse(await invocar("contratos_alertas", { hoy }));
}

/** El reporte sin la unica linea no determinista. */
function alertasSinSello(): string {
  return readFileSync(RUTA_ALERTAS, "utf8")
    .split("\n")
    .filter((linea) => !linea.startsWith("Generado:"))
    .join("\n");
}

function ids(filas: readonly { id_contrato: string }[]): string {
  return filas.map((fila) => fila.id_contrato).join(", ");
}

function lineasHistorial(): readonly Record<string, unknown>[] {
  if (!existsSync(RUTA_HISTORIAL)) {
    return [];
  }
  return readFileSync(RUTA_HISTORIAL, "utf8")
    .split("\n")
    .filter((linea) => linea.trim() !== "")
    .map((linea) => {
      const analizado: unknown = JSON.parse(linea);
      return typeof analizado === "object" && analizado !== null
        ? (analizado as Record<string, unknown>)
        : {};
    });
}

const esquemaBuzon = z.object({
  total: z.number(),
  mensajes: z.array(
    z.object({
      id: z.string(),
      de: z.string(),
      asunto: z.string(),
      fecha: z.string(),
      adjuntos: z.array(z.string()),
      tiene_contrato: z.boolean(),
    }),
  ),
});

/** Extraccion de un mensaje, o una excepcion si el mensaje no existe. */
function extraccion(mensajeId: string): Extraccion {
  const resultado = extraerDeMensaje(mensajeId);
  if (typeof resultado === "string") {
    throw new Error(`${mensajeId}: ${resultado}`);
  }
  return resultado;
}

function campo(mensajeId: string, nombre: NombreCampo): Campo {
  return extraccion(mensajeId).campos[nombre];
}

function validacion(mensajeId: string): Validacion {
  return validarExtraccion(extraccion(mensajeId));
}

/**
 * Grupo de polizas ANTES de registrar nada, capturado por la verificacion
 * del fixture. La comparacion "antes no aparecia / ahora si" lo necesita,
 * porque en cuanto se registra msg-003 el maestro vivo ya es la copia.
 */
let polizasAntesDeRegistrar: readonly string[] = [];

/** Huella de un arbol: ruta, tamano y fecha de modificacion de cada archivo. */
function huella(raiz: string): string {
  if (!existsSync(raiz)) {
    return `${raiz}: (no existe)`;
  }
  // Sirve tambien para un archivo suelto, no solo para un directorio.
  if (!statSync(raiz).isDirectory()) {
    const info = statSync(raiz);
    return `${raiz}|${info.size}|${info.mtimeMs}`;
  }
  const lineas: string[] = [];
  const recorrer = (directorio: string): void => {
    for (const entrada of readdirSync(directorio, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const ruta = join(directorio, entrada.name);
      if (entrada.isDirectory()) {
        recorrer(ruta);
        continue;
      }
      const info = statSync(ruta);
      lineas.push(`${ruta}|${info.size}|${info.mtimeMs}`);
    }
  };
  recorrer(raiz);
  return lineas.join("\n");
}

// ---------------------------------------------------------------------------
// Verificaciones
// ---------------------------------------------------------------------------

const verificaciones: readonly Verificacion[] = [
  {
    titulo:
      "los seis mensajes se listan cuando no hay out/procesados.json",
    correr: async () => {
      if (existsSync(RUTA_PROCESADOS)) {
        return {
          pasa: false,
          detalle: `precondicion rota: ${RUTA_PROCESADOS} existe, la verificacion mide el caso en que no hay nada procesado`,
        };
      }
      const datos = esquemaBuzon.parse(
        await invocar("contratos_leer_buzon", {}),
      );
      const ids = datos.mensajes.map((mensaje) => mensaje.id);
      const pasa =
        datos.total === 6 && JSON.stringify(ids) === JSON.stringify(IDS);
      return {
        pasa,
        detalle: `total=${datos.total} ids=[${ids.join(", ")}] (la ausencia del archivo no es error)`,
      };
    },
  },
  {
    titulo:
      "msg-005, que trae una cotizacion, sale con tiene_contrato false",
    correr: async () => {
      const datos = esquemaBuzon.parse(
        await invocar("contratos_leer_buzon", {}),
      );
      const mensaje = datos.mensajes.find((fila) => fila.id === "msg-005");
      const pasa = mensaje !== undefined && mensaje.tiene_contrato === false;
      return {
        pasa,
        detalle: `adjunto=${mensaje?.adjuntos.join(",") ?? "(ninguno)"} tiene_contrato=${String(mensaje?.tiene_contrato)} tipo=${extraccion("msg-005").tipo_documento}`,
      };
    },
  },
  {
    titulo: "msg-003, que trae un otrosi, sale con tiene_contrato true",
    correr: async () => {
      const datos = esquemaBuzon.parse(
        await invocar("contratos_leer_buzon", {}),
      );
      const mensaje = datos.mensajes.find((fila) => fila.id === "msg-003");
      const pasa = mensaje !== undefined && mensaje.tiene_contrato === true;
      return {
        pasa,
        detalle: `adjunto=${mensaje?.adjuntos.join(",") ?? "(ninguno)"} tiene_contrato=${String(mensaje?.tiene_contrato)} tipo=${extraccion("msg-003").tipo_documento}`,
      };
    },
  },
  {
    titulo:
      "extraer sobre msg-001 devuelve los once campos con su confianza",
    correr: () => {
      const datos = extraccion("msg-001");
      const esperado: Readonly<Record<NombreCampo, unknown>> = {
        id_contrato: "CT-2026-015",
        cliente: "Industrias Delta S.A.S.",
        nit_cliente: "890900111",
        pais: "CO",
        objeto: null, // solo se verifica que no este vacio
        valor: 265000000,
        moneda: "COP",
        fecha_inicio: "2026-08-01",
        fecha_fin: "2027-07-31",
        requiere_poliza: true,
        tipo_poliza: "cumplimiento",
      };
      const fallos: string[] = [];
      for (const nombre of NOMBRES_CAMPO) {
        const leido = datos.campos[nombre];
        if (typeof leido.confianza !== "number" || leido.confianza < 0 || leido.confianza > 1) {
          fallos.push(`${nombre}: confianza fuera de [0,1]`);
          continue;
        }
        if (nombre === "objeto") {
          if (typeof leido.valor !== "string" || leido.valor.length < 20) {
            fallos.push("objeto: vacio o demasiado corto");
          }
          continue;
        }
        if (leido.valor !== esperado[nombre]) {
          fallos.push(
            `${nombre}: ${JSON.stringify(leido.valor)} != ${JSON.stringify(esperado[nombre])}`,
          );
        }
      }
      if (datos.requiere_revision.length !== 0) {
        fallos.push(
          `no deberia requerir revision, y pide: ${datos.requiere_revision.join(", ")}`,
        );
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `11 campos correctos, confianza minima ${Math.min(...NOMBRES_CAMPO.map((n) => datos.campos[n].confianza))}, sin revision`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "extraer sobre msg-006 marca baja confianza en valor y fecha_fin",
    correr: () => {
      const datos = extraccion("msg-006");
      const valor = datos.campos.valor;
      const fin = datos.campos.fecha_fin;
      const pasa =
        valor.confianza < CORTE_REVISION &&
        fin.confianza < CORTE_REVISION &&
        valor.valor === 0 &&
        datos.valor_indeterminado === true &&
        datos.requiere_revision.includes("valor") &&
        datos.requiere_revision.includes("fecha_fin");
      return {
        pasa,
        detalle: `valor=${JSON.stringify(valor.valor)} conf=${valor.confianza} | fecha_fin=${JSON.stringify(fin.valor)} conf=${fin.confianza} | valor_indeterminado=${String(datos.valor_indeterminado)}`,
      };
    },
  },
  {
    titulo:
      "un campo ausente sale null con confianza 0 (msg-006, moneda)",
    correr: () => {
      const moneda = campo("msg-006", "moneda");
      const pasa =
        moneda.valor === null &&
        moneda.confianza === 0 &&
        moneda.estado === "ausente";
      return {
        pasa,
        detalle: `valor=${JSON.stringify(moneda.valor)} confianza=${moneda.confianza} estado=${moneda.estado} | nota: ${moneda.nota ?? "(ninguna)"}`,
      };
    },
  },
  {
    titulo:
      "un campo no_aplica NO entra en requiere_revision y uno ausente SI",
    correr: () => {
      const otrosi = extraccion("msg-003");
      const marco = extraccion("msg-006");
      const objeto = otrosi.campos.objeto;
      const inicioOtrosi = otrosi.campos.fecha_inicio;
      const moneda = marco.campos.moneda;

      const fallos: string[] = [];
      if (objeto.estado !== "no_aplica" || inicioOtrosi.estado !== "no_aplica") {
        fallos.push(
          `en el otrosi objeto=${objeto.estado} fecha_inicio=${inicioOtrosi.estado}, se esperaban no_aplica`,
        );
      }
      if (objeto.confianza >= CORTE_REVISION) {
        fallos.push("no_aplica no puede salvarse subiendo la confianza");
      }
      if (otrosi.requiere_revision.includes("objeto")) {
        fallos.push("objeto no_aplica entro en requiere_revision");
      }
      if (otrosi.requiere_revision.includes("fecha_inicio")) {
        fallos.push("fecha_inicio no_aplica entro en requiere_revision");
      }
      if (otrosi.requiere_revision.length !== 0) {
        fallos.push(
          `el otrosi deberia registrarse limpio (RN2) y pide revision de: ${otrosi.requiere_revision.join(", ")}`,
        );
      }
      if (moneda.estado !== "ausente") {
        fallos.push(`moneda del marco = ${moneda.estado}, se esperaba ausente`);
      }
      if (!marco.requiere_revision.includes("moneda")) {
        fallos.push("moneda ausente NO entro en requiere_revision");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `otrosi: objeto y fecha_inicio no_aplica con confianza ${objeto.confianza}, fuera de RN5, revision=[] | marco: moneda ausente con confianza ${moneda.confianza}, dentro de RN5`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "msg-006 sale con valor, moneda, fecha_inicio y fecha_fin bajo 0.8, mas requiere_poliza y tipo_poliza en 0.3",
    correr: () => {
      const datos = extraccion("msg-006");
      const esperados: readonly NombreCampo[] = [
        "valor",
        "moneda",
        "fecha_inicio",
        "fecha_fin",
        "requiere_poliza",
        "tipo_poliza",
      ];
      const fallos: string[] = [];
      for (const nombre of esperados) {
        if (datos.campos[nombre].confianza >= CORTE_REVISION) {
          fallos.push(
            `${nombre} = ${datos.campos[nombre].confianza}, deberia estar bajo ${CORTE_REVISION}`,
          );
        }
      }
      const sobrantes = datos.requiere_revision.filter(
        (nombre) => !esperados.includes(nombre),
      );
      if (sobrantes.length !== 0) {
        fallos.push(`campos en revision de mas: ${sobrantes.join(", ")}`);
      }
      for (const nombre of ["requiere_poliza", "tipo_poliza"] as const) {
        if (datos.campos[nombre].confianza !== 0.3) {
          fallos.push(
            `${nombre} = ${datos.campos[nombre].confianza}, se esperaba 0.3 (clausula condicional, no false)`,
          );
        }
      }
      if (datos.campos.requiere_poliza.valor !== true) {
        fallos.push(
          "requiere_poliza del marco no puede ser false: apagaria la alerta sobre una clausula que un humano debe leer",
        );
      }
      const confianzas = esperados
        .map((n) => `${n}=${datos.campos[n].confianza}`)
        .join(" ");
      return {
        pasa: fallos.length === 0,
        detalle: fallos.length === 0 ? confianzas : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "la fecha literal gana sobre el plazo en meses cuando el texto trae ambos (msg-002)",
    correr: () => {
      const fin = campo("msg-002", "fecha_fin");
      const pasa =
        fin.valor === "2027-08-14" &&
        fin.estado === "leido" &&
        fin.confianza === 0.9;
      return {
        pasa,
        detalle: `el contrato dice "doce (12) meses" y tambien la fecha; queda ${JSON.stringify(fin.valor)} estado=${fin.estado} conf=${fin.confianza} (derivar habria dado 0.6)`,
      };
    },
  },
  {
    titulo:
      "los campos extraidos de msg-004 casan con la fila real del maestro",
    correr: () => {
      const datos = extraccion("msg-004");
      const fila = readFileSync(RUTA_MAESTRO, "utf8")
        .split("\n")
        .find((linea) => linea.startsWith("CT-2026-012,"));
      if (fila === undefined) {
        return { pasa: false, detalle: "no se hallo CT-2026-012 en el maestro" };
      }
      const columnas = fila.split(",");
      const fallos: string[] = [];
      const comparar = (nombre: NombreCampo, indice: number): void => {
        const esperado = columnas[indice] ?? "";
        const obtenido = datos.campos[nombre].valor;
        if (String(obtenido ?? "") !== esperado) {
          fallos.push(`${nombre}: ${JSON.stringify(obtenido)} != "${esperado}"`);
        }
      };
      comparar("id_contrato", 0);
      comparar("cliente", 1);
      comparar("nit_cliente", 2);
      comparar("pais", 3);
      comparar("valor", 5);
      comparar("moneda", 6);
      comparar("fecha_inicio", 7);
      comparar("fecha_fin", 8);
      comparar("requiere_poliza", 9);
      comparar("tipo_poliza", 10);
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? "id, cliente, nit, pais, valor, moneda, fechas, poliza y tipo coinciden con el CSV (normalizacion verificada contra el maestro)"
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "leer_buzon y extraer no escriben nada en disco",
    correr: async () => {
      const antesFixtures = huella("fixtures");
      const antesOut = huella("out");
      await invocar("contratos_leer_buzon", {});
      for (const id of IDS) {
        await invocar("contratos_extraer", { mensaje_id: id });
      }
      const fallos: string[] = [];
      if (huella("fixtures") !== antesFixtures) {
        fallos.push("el arbol fixtures/ cambio");
      }
      if (huella("out") !== antesOut) {
        fallos.push("el arbol out/ cambio");
      }
      if (existsSync(RUTA_PROCESADOS)) {
        fallos.push(`se creo ${RUTA_PROCESADOS}`);
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? "1 llamada a leer_buzon y 6 a extraer: rutas, tamanos y fechas de modificacion identicos en fixtures/ y out/"
            : fallos.join("; "),
      };
    },
  },
  {
    titulo: "msg-001 y msg-002 salen nuevo (RN3)",
    correr: () => {
      const fallos: string[] = [];
      const detalles: string[] = [];
      for (const id of ["msg-001", "msg-002"]) {
        const datos = validacion(id);
        detalles.push(
          `${id}=${datos.clasificacion}/${datos.regla} id=${datos.id_contrato}`,
        );
        if (datos.clasificacion !== "nuevo" || datos.regla !== "RN3") {
          fallos.push(`${id}: ${datos.clasificacion} (${datos.regla})`);
        }
        if (datos.coincidencia !== null) {
          fallos.push(`${id}: no deberia coincidir con ninguna fila del maestro`);
        }
        if (datos.requiere_revision.length !== 0) {
          fallos.push(
            `${id}: deberia registrarse limpio y pide ${datos.requiere_revision.join("; ")}`,
          );
        }
      }
      return {
        pasa: fallos.length === 0,
        detalle: fallos.length === 0 ? detalles.join(" | ") : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "msg-003 sale actualizacion contra CT-2026-011 del maestro (RN2)",
    correr: () => {
      const datos = validacion("msg-003");
      const cambiados = soloCambios(datos.diferencias).map((cambio: Diferencia) => cambio.campo);
      const pasa =
        datos.clasificacion === "actualizacion" &&
        datos.regla === "RN2" &&
        datos.coincidencia?.id_contrato === "CT-2026-011" &&
        cambiados.includes("valor") &&
        cambiados.includes("fecha_fin") &&
        soloConflictos(datos.diferencias).length === 0;
      return {
        pasa,
        detalle: `${datos.clasificacion}/${datos.regla} contra ${datos.coincidencia?.id_contrato ?? "(nada)"} | cambios: ${soloCambios(datos.diferencias).map((c: Diferencia) => `${c.campo} ${c.maestro}->${c.extraido}`).join(", ")} | motivo: ${datos.motivo ?? "(ninguno)"}`,
      };
    },
  },
  {
    titulo:
      "msg-004 sale duplicado contra CT-2026-012, con los campos identicos (RN1)",
    correr: () => {
      const datos = validacion("msg-004");
      const pasa =
        datos.clasificacion === "duplicado" &&
        datos.regla === "RN1" &&
        datos.coincidencia?.id_contrato === "CT-2026-012" &&
        soloCambios(datos.diferencias).length === 0 &&
        soloConflictos(datos.diferencias).length === 0;
      return {
        pasa,
        detalle: `${datos.clasificacion}/${datos.regla} contra ${datos.coincidencia?.id_contrato ?? "(nada)"} | cambios=${soloCambios(datos.diferencias).length} conflictos=${soloConflictos(datos.diferencias).length} | ${datos.motivo ?? ""}`,
      };
    },
  },
  {
    titulo: "msg-005 sale rechazado por RN4, con motivo",
    correr: () => {
      const datos = validacion("msg-005");
      const pasa =
        datos.clasificacion === "rechazado" &&
        datos.regla === "RN4" &&
        typeof datos.motivo === "string" &&
        datos.motivo.length > 0;
      return {
        pasa,
        detalle: `${datos.clasificacion}/${datos.regla} | motivo: ${datos.motivo ?? "(SIN MOTIVO)"}`,
      };
    },
  },
  {
    titulo: "msg-006 sale nuevo con requiere_revision no vacio",
    correr: () => {
      const datos = validacion("msg-006");
      const pasa =
        datos.clasificacion === "nuevo" &&
        datos.regla === "RN3" &&
        datos.requiere_revision.length === 6;
      return {
        pasa,
        detalle: `${datos.clasificacion}/${datos.regla} | ${datos.requiere_revision.length} campos en revision: ${datos.requiere_revision.join(" ; ")}`,
      };
    },
  },
  {
    titulo:
      "el remitente de msg-006 no esta en comerciales.json: se reporta y NO bloquea",
    correr: () => {
      const desconocido = validacion("msg-006");
      const conocido = validacion("msg-001");
      const fallos: string[] = [];
      if (desconocido.comercial.conocido !== false) {
        fallos.push("jperez@ no deberia resolverse como comercial conocido");
      }
      if (desconocido.comercial.nombre !== null) {
        fallos.push("no se debe inventar un nombre para un remitente desconocido");
      }
      if (!desconocido.avisos.some((aviso) => aviso.includes("jperez"))) {
        fallos.push("el remitente desconocido no se reporto en avisos");
      }
      if (desconocido.clasificacion !== "nuevo") {
        fallos.push(
          `el remitente desconocido bloqueo la clasificacion: clasificacion=${desconocido.clasificacion}`,
        );
      }
      if (
        desconocido.requiere_revision.some((linea) =>
          linea.includes("remitente"),
        )
      ) {
        fallos.push("el remitente desconocido no debe entrar en requiere_revision");
      }
      if (
        conocido.comercial.conocido !== true ||
        conocido.comercial.nombre !== "Laura Gómez Restrepo" ||
        conocido.comercial.region !== "Colombia"
      ) {
        fallos.push(
          `el remitente conocido de msg-001 no se resolvio: ${JSON.stringify(conocido.comercial)}`,
        );
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `msg-006 comercial=(desconocido, nombre null) clasificacion=${desconocido.clasificacion} aviso emitido | msg-001 comercial="${conocido.comercial.nombre ?? ""}" region="${conocido.comercial.region ?? ""}"`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "un conflicto con el maestro entra en requiere_revision aunque el campo tenga confianza alta",
    correr: () => {
      // Los fixtures no contienen ningun conflicto real: los campos de
      // identidad de msg-003 y msg-004 casan con su fila. Se construye el
      // caso alterando EN MEMORIA una copia de la fila real CT-2026-012;
      // el CSV en disco no se toca.
      const maestro = leerMaestro();
      const original = maestro.filas.find(
        (fila) => fila.id_contrato === "CT-2026-012",
      );
      if (original === undefined) {
        return { pasa: false, detalle: "no se hallo CT-2026-012 en el maestro" };
      }
      const alterada = { ...original, moneda: "USD" };
      const datos = extraccion("msg-004");
      const resultado = validarExtraccion(datos, {
        fuente: `${maestro.fuente} (copia en memoria, moneda COP->USD)`,
        filas: [alterada],
      });
      const confianzaMoneda = datos.campos.moneda.confianza;
      const conflicto = soloConflictos(resultado.diferencias).find(
        (diferencia: Diferencia) => diferencia.campo === "moneda",
      );
      const enRevision = resultado.requiere_revision.filter((linea) =>
        linea.startsWith("moneda:"),
      );
      const fallos: string[] = [];
      if (confianzaMoneda < CORTE_REVISION) {
        fallos.push(
          `la premisa exige confianza alta y moneda vale ${confianzaMoneda}`,
        );
      }
      if (conflicto === undefined) {
        fallos.push("no se detecto el conflicto de moneda");
      }
      if (enRevision.length !== 1) {
        fallos.push(
          `requiere_revision no recogio el conflicto: [${resultado.requiere_revision.join(" ; ")}]`,
        );
      }
      if (datos.requiere_revision.includes("moneda")) {
        fallos.push(
          "moneda no deberia estar en revision por confianza: entra solo por el conflicto",
        );
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `moneda confianza=${confianzaMoneda} (>= ${CORTE_REVISION}) y aun asi entra: "${enRevision[0] ?? ""}" | clasificacion=${resultado.clasificacion}`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo: "validar no escribe nada en disco",
    correr: async () => {
      const antesFixtures = huella("fixtures");
      const antesOut = huella("out");
      for (const id of IDS) {
        await invocar("contratos_validar", { mensaje_id: id });
      }
      const fallos: string[] = [];
      if (huella("fixtures") !== antesFixtures) {
        fallos.push("el arbol fixtures/ cambio");
      }
      if (huella("out") !== antesOut) {
        fallos.push("el arbol out/ cambio");
      }
      if (existsSync(join("out", "sharepoint"))) {
        fallos.push(
          "se creo out/sharepoint: validar solo lee el maestro, no lo copia (RN6 es tarea de registrar)",
        );
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `6 llamadas a validar: rutas, tamanos y fechas de modificacion identicos en fixtures/ y out/, y out/sharepoint no se creo`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "alertas con corte 2026-09-03 sobre el fixture: 2 vencidos, 2 por vencer, 1 poliza, 1 remitente",
    correr: async () => {
      const salida = await correrAlertas("2026-09-03");
      polizasAntesDeRegistrar = salida.polizas_pendientes.map(
        (fila) => fila.id_contrato,
      );
      const fallos: string[] = [];

      // Conteo hecho a mano contra el CSV: ventana hasta 2026-11-02.
      if (ids(salida.vencidos) !== "CT-2025-018, CT-2026-002") {
        fallos.push(`vencidos=[${ids(salida.vencidos)}], se esperaban CT-2025-018 y CT-2026-002`);
      }
      if (ids(salida.vencen) !== "CT-2026-009, CT-2026-004") {
        fallos.push(`vencen=[${ids(salida.vencen)}], se esperaban CT-2026-009 y CT-2026-004`);
      }
      // El caso que separa un umbral bien puesto de uno que lista todo.
      if (ids(salida.vencen).includes("CT-2026-012")) {
        fallos.push("CT-2026-012 vence a 72 dias y no debe entrar en la ventana de 60");
      }
      if (salida.vencidos[0]?.dias !== -65 || salida.vencen[0]?.dias !== 27) {
        fallos.push(
          `dias mal calculados: ${salida.vencidos[0]?.dias} y ${salida.vencen[0]?.dias}, se esperaban -65 y 27`,
        );
      }
      if (ids(salida.polizas_pendientes) !== "CT-2026-004") {
        fallos.push(`polizas=[${ids(salida.polizas_pendientes)}]`);
      }
      if (salida.registrados_desde_corte.length !== 0) {
        fallos.push(
          `registrados desde el corte=${salida.registrados_desde_corte.length}, el fixture no tiene ninguno posterior a 2026-05-30`,
        );
      }
      if (salida.total_alertas !== 6) {
        fallos.push(`total=${salida.total_alertas}, se esperaban 6`);
      }
      if (!existsSync(RUTA_ALERTAS)) {
        fallos.push("no se escribio out/alertas.md");
      }
      if (salida.hoy !== "2026-09-03") {
        fallos.push("el reporte no devuelve la fecha de corte con la que calculo");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `vencidos=[${ids(salida.vencidos)}] vencen=[${ids(salida.vencen)}] polizas=[${ids(salida.polizas_pendientes)}] total=${salida.total_alertas} | CT-2026-012 (72 dias) excluido`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "un contrato con requiere_poliza true y estado_poliza pendiente aparece en el grupo de polizas",
    correr: async () => {
      const salida = await correrAlertas("2026-09-03");
      const fila = salida.polizas_pendientes.find(
        (una) => una.id_contrato === "CT-2026-004",
      );
      const contenido = readFileSync(RUTA_ALERTAS, "utf8");
      const fallos: string[] = [];
      if (fila === undefined) {
        fallos.push("CT-2026-004 no esta en el grupo de polizas");
      } else if (fila.estado_poliza !== "pendiente") {
        fallos.push(`estado_poliza=${fila.estado_poliza}`);
      }
      // Los vigentes no deben colarse aunque exijan poliza.
      for (const vigente of ["CT-2025-018", "CT-2026-006", "CT-2026-011"]) {
        if (ids(salida.polizas_pendientes).includes(vigente)) {
          fallos.push(`${vigente} tiene poliza vigente y no deberia aparecer`);
        }
      }
      if (!contenido.includes("Poliza exigida sin vigencia confirmada (1)")) {
        fallos.push("el markdown no refleja el grupo de polizas");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `CT-2026-004 estado=pendiente tipo=cumplimiento;calidad | los tres con poliza vigente quedan fuera`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo: "el remitente de msg-006 aparece en el grupo de no resueltos",
    correr: async () => {
      const salida = await correrAlertas("2026-09-03");
      const fila = salida.remitentes_no_resueltos.find((una) =>
        una.email.includes("jperez"),
      );
      const fallos: string[] = [];
      if (fila === undefined) {
        fallos.push("jperez@ no aparece");
      } else if (!fila.detalle.includes("msg-006")) {
        fallos.push(`no dice de donde sale: ${fila.detalle}`);
      }
      // Los tres comerciales de comerciales.json no deben aparecer.
      if (salida.remitentes_no_resueltos.length !== 1) {
        fallos.push(
          `hay ${salida.remitentes_no_resueltos.length} remitentes, se esperaba 1`,
        );
      }
      if (!readFileSync(RUTA_ALERTAS, "utf8").includes("jperez@periferia-ficticia.com")) {
        fallos.push("el markdown no lo lista");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `${fila?.email ?? ""} [${fila?.origen ?? ""}] ${fila?.detalle ?? ""}`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "dos llamadas con la misma fecha de corte dan el mismo reporte, salvo el sello de tiempo",
    correr: async () => {
      await correrAlertas("2026-09-03");
      const primero = alertasSinSello();
      const conSello1 = readFileSync(RUTA_ALERTAS, "utf8");
      await correrAlertas("2026-09-03");
      const segundo = alertasSinSello();
      const conSello2 = readFileSync(RUTA_ALERTAS, "utf8");
      const fallos: string[] = [];
      if (primero !== segundo) {
        fallos.push("el reporte cambio entre dos corridas con la misma fecha");
      }
      if (conSello1 === conSello2) {
        fallos.push(
          "el sello de tiempo no cambio: la comparacion no esta probando nada",
        );
      }
      // Y con otra fecha de corte, el reporte SI debe cambiar.
      await correrAlertas("2026-12-01");
      const otro = alertasSinSello();
      if (otro === primero) {
        fallos.push("cambiar la fecha de corte no cambio el reporte");
      }
      await correrAlertas("2026-09-03");
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `${primero.split("\n").length} lineas identicas byte a byte; solo difiere "Generado:"; con corte 2026-12-01 el contenido cambia`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo: "alertas no toca el maestro, ni el historial, ni procesados",
    correr: async () => {
      const antesFixtures = huella("fixtures");
      const antesSharepoint = huella(RAIZ_SHAREPOINT);
      const antesProcesados = existsSync(RUTA_PROCESADOS);
      await correrAlertas("2026-09-03");
      const fallos: string[] = [];
      if (huella("fixtures") !== antesFixtures) {
        fallos.push("el arbol fixtures/ cambio");
      }
      if (huella(RAIZ_SHAREPOINT) !== antesSharepoint) {
        fallos.push("out/sharepoint cambio");
      }
      if (existsSync(RUTA_PROCESADOS) !== antesProcesados) {
        fallos.push("toco out/procesados.json");
      }
      if (!existsSync(RUTA_ALERTAS)) {
        fallos.push("no escribio el unico archivo que le toca");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `fixtures/ y ${RAIZ_SHAREPOINT} intactos, procesados intacto; solo escribio ${RUTA_ALERTAS}`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "msg-001 limpio se registra: fila nueva, archivo copiado, historial y procesados",
    correr: async () => {
      const salida = await registrarMensaje("msg-001", false);
      const fila = filaCopia("CT-2026-015");
      const historial = lineasHistorial();
      const fallos: string[] = [];

      if (salida.accion !== "nuevo") {
        fallos.push(`accion=${salida.accion}, se esperaba nuevo`);
      }
      if (fila === null) {
        fallos.push("no se inserto la fila CT-2026-015 en la copia");
      } else {
        if (fila.valor !== "265000000" || fila.moneda !== "COP") {
          fallos.push(`valor/moneda: ${fila.valor}/${fila.moneda}`);
        }
        if (fila.estado_poliza !== "pendiente") {
          fallos.push(
            `estado_poliza=${fila.estado_poliza}, 7.4 espera pendiente`,
          );
        }
        if (fila.comercial !== "Laura Gómez Restrepo") {
          fallos.push(`comercial=${fila.comercial}`);
        }
        if (fila.fecha_registro !== HOY || fila.fuente !== "buzon") {
          fallos.push(`fecha_registro/fuente: ${fila.fecha_registro}/${fila.fuente}`);
        }
        if (fila.ruta_sharepoint !== salida.ruta_archivo) {
          fallos.push("la ruta de la fila no coincide con la devuelta");
        }
      }
      if (!existsSync(join(RAIZ_SHAREPOINT, ...(salida.ruta_archivo ?? "").split("/")))) {
        fallos.push("el adjunto no se copio al destino");
      }
      if (historial.length !== 1 || historial[0]?.id_contrato !== "CT-2026-015") {
        fallos.push(`historial con ${historial.length} lineas`);
      }
      if (!existsSync(RUTA_PROCESADOS)) {
        fallos.push("no se marco el mensaje como procesado");
      }
      if (salida.archivado?.origen !== "fecha_inicio") {
        fallos.push(`origen del anio=${salida.archivado?.origen ?? "(ninguno)"}`);
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `${salida.accion} ${salida.id_contrato} -> ${salida.ruta_archivo} | ${salida.archivado?.explicacion ?? ""} | escrituras: ${salida.escrituras.length}`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "msg-004 duplicado NO escribe nada, ni con confirmado true: huella identica",
    correr: async () => {
      const antesFixtures = huella("fixtures");
      const antesOut = huella("out");
      const sobre = await invocarCrudo("contratos_registrar", {
        mensaje_id: "msg-004",
        confirmado: true,
        hoy: HOY,
        comprobante: comprobanteVivo("msg-004"),
      });
      const fallos: string[] = [];
      if (sobre.ok !== false) {
        fallos.push("un duplicado deberia devolver sobre de error");
      }
      if (typeof sobre.error !== "string" || !sobre.error.includes("DUPLICADO")) {
        fallos.push(`el error no lo explica: ${sobre.error ?? ""}`);
      }
      if (huella("fixtures") !== antesFixtures) {
        fallos.push("el arbol fixtures/ cambio");
      }
      if (huella("out") !== antesOut) {
        fallos.push("el arbol out/ cambio");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `confirmado=true y comprobante valido, y aun asi 0 escrituras | ${(sobre.error ?? "").slice(0, 110)}`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "msg-003 actualiza CT-2026-011 y los campos no_aplica conservan su valor anterior",
    correr: async () => {
      const antes = filaCopia("CT-2026-011");
      if (antes === null) {
        return { pasa: false, detalle: "CT-2026-011 no esta en la copia" };
      }
      const previo = { ...antes };
      const salida = await registrarMensaje("msg-003", false);
      const despues = filaCopia("CT-2026-011");
      if (despues === null) {
        return { pasa: false, detalle: "la fila desaparecio tras actualizar" };
      }
      const fallos: string[] = [];
      if (salida.accion !== "actualizacion") {
        fallos.push(`accion=${salida.accion}`);
      }
      // Columna por columna.
      const conserva: readonly string[] = [
        "objeto",
        "fecha_inicio",
        "cliente",
        "nit_cliente",
        "pais",
        "moneda",
      ];
      for (const columna of conserva) {
        if (despues[columna] !== previo[columna]) {
          fallos.push(
            `${columna}: "${previo[columna]}" -> "${despues[columna]}", deberia conservarse`,
          );
        }
      }
      if (despues.valor !== "520000") {
        fallos.push(`valor=${despues.valor}, se esperaba 520000`);
      }
      if (despues.fecha_fin !== "2027-11-01") {
        fallos.push(`fecha_fin=${despues.fecha_fin}`);
      }
      if (previo.estado_poliza !== "vigente") {
        fallos.push(`premisa: estado_poliza previo era ${previo.estado_poliza}`);
      }
      if (despues.estado_poliza !== "pendiente") {
        fallos.push(
          `estado_poliza=${despues.estado_poliza}: cambiaron valor y fecha_fin sobre un contrato con poliza, deberia bajar a pendiente`,
        );
      }
      const linea = lineasHistorial().find(
        (fila) => fila.id_contrato === "CT-2026-011",
      );
      if (linea === undefined || linea.accion !== "actualizacion") {
        fallos.push("no hay linea de historial de la actualizacion");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `objeto y fecha_inicio (no_aplica) intactos: "${despues.objeto}" / ${despues.fecha_inicio} | valor ${previo.valor}->${despues.valor} | fecha_fin ${previo.fecha_fin}->${despues.fecha_fin} | estado_poliza ${previo.estado_poliza}->${despues.estado_poliza}`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo: "msg-006 sin confirmar NO escribe nada",
    correr: async () => {
      const antesFixtures = huella("fixtures");
      const antesOut = huella("out");
      const sobre = await invocarCrudo("contratos_registrar", {
        mensaje_id: "msg-006",
        confirmado: false,
        hoy: HOY,
        comprobante: comprobanteVivo("msg-006"),
      });
      const fallos: string[] = [];
      if (sobre.ok !== false) {
        fallos.push("deberia devolver el sobre de error");
      }
      if (typeof sobre.error !== "string" || !sobre.error.includes("valor")) {
        fallos.push("el error no nombra los campos que faltan por confirmar");
      }
      if (huella("fixtures") !== antesFixtures || huella("out") !== antesOut) {
        fallos.push("escribio algo");
      }
      if (filaCopia("CM-2026-03") !== null) {
        fallos.push("inserto la fila en el maestro");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `ok=false, 0 escrituras | ${(sobre.error ?? "").slice(0, 150)}...`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "tras registrar msg-003, CT-2026-011 aparece en el grupo de polizas y antes no aparecia",
    correr: async () => {
      const fallos: string[] = [];
      if (polizasAntesDeRegistrar.length === 0) {
        return {
          pasa: false,
          detalle:
            "no se capturo el grupo de polizas previo: la comparacion antes/despues no prueba nada",
        };
      }
      if (polizasAntesDeRegistrar.includes("CT-2026-011")) {
        fallos.push("CT-2026-011 ya estaba en el grupo antes de registrar");
      }
      const salida = await correrAlertas("2026-09-03");
      const fila = salida.polizas_pendientes.find(
        (una) => una.id_contrato === "CT-2026-011",
      );
      if (fila === undefined) {
        fallos.push("CT-2026-011 no aparece tras el otrosi");
      } else if (fila.estado_poliza !== "pendiente") {
        fallos.push(`estado_poliza=${fila.estado_poliza}`);
      }
      if (salida.fuente_maestro !== RUTA_COPIA) {
        fallos.push(
          `leyo ${salida.fuente_maestro}, deberia leer el maestro vivo ${RUTA_COPIA}`,
        );
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `antes=[${polizasAntesDeRegistrar.join(", ")}] despues=[${ids(salida.polizas_pendientes)}] | el otrosi cambio valor y fecha_fin, asi que la poliza vigente dejo de cubrir el contrato (S-14)`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "correcciones sin confirmado no aplica nada y lo reporta en correcciones_ignoradas",
    correr: async () => {
      const antesFixtures = huella("fixtures");
      const antesOut = huella("out");
      const sobre = await invocarCrudo("contratos_registrar", {
        mensaje_id: "msg-006",
        confirmado: false,
        hoy: HOY,
        comprobante: comprobanteVivo("msg-006"),
        correcciones: { fecha_fin: "2027-08-31" },
      });
      const fallos: string[] = [];
      if (sobre.ok !== false) {
        fallos.push("deberia seguir rechazando: sin confirmar no se escribe");
      }
      if (huella("fixtures") !== antesFixtures || huella("out") !== antesOut) {
        fallos.push("escribio algo");
      }
      if (filaCopia("CM-2026-03") !== null) {
        fallos.push("inserto la fila");
      }
      // La correccion no se aplico: el campo sigue en la lista de revision.
      if (
        typeof sobre.error !== "string" ||
        !sobre.error.includes("fecha_fin")
      ) {
        fallos.push("fecha_fin ya no figura como pendiente de confirmar");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? "correccion descartada, 0 escrituras, fecha_fin sigue en revision"
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "correcciones sobre un campo que NO estaba en requiere_revision se rechaza",
    correr: async () => {
      const antesOut = huella("out");
      // cliente en msg-006 se leyo del documento con confianza 0.9.
      const sobre = await invocarCrudo("contratos_registrar", {
        mensaje_id: "msg-006",
        confirmado: true,
        hoy: HOY,
        comprobante: comprobanteVivo("msg-006"),
        correcciones: { cliente: "Otra Empresa S.A.S." },
      });
      const fallos: string[] = [];
      if (sobre.ok !== false) {
        fallos.push("deberia rechazar la sobreescritura");
      }
      if (
        typeof sobre.error !== "string" ||
        !sobre.error.includes("cliente") ||
        !sobre.error.includes("sobreescritura")
      ) {
        fallos.push(`el error no explica por que: ${sobre.error ?? ""}`);
      }
      if (huella("out") !== antesOut) {
        fallos.push("escribio algo");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `rechazado sin escribir | ${(sobre.error ?? "").slice(0, 170)}`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "una fecha con formato invalido se rechaza, y una inexistente tambien",
    correr: async () => {
      const antesOut = huella("out");
      const fallos: string[] = [];
      const detalles: string[] = [];
      const casos: readonly [string, string][] = [
        ["31/08/2027", "formato"],
        ["2027-02-31", "calendario"],
      ];
      for (const [valor, clase] of casos) {
        const sobre = await invocarCrudo("contratos_registrar", {
          mensaje_id: "msg-006",
          confirmado: true,
          hoy: HOY,
          comprobante: comprobanteVivo("msg-006"),
          correcciones: { fecha_fin: valor },
        });
        if (sobre.ok !== false) {
          fallos.push(`"${valor}" (${clase}) fue aceptada`);
          continue;
        }
        detalles.push(`"${valor}" -> ${(sobre.error ?? "").slice(0, 60)}`);
      }
      if (huella("out") !== antesOut) {
        fallos.push("escribio algo");
      }
      if (filaCopia("CM-2026-03") !== null) {
        fallos.push("inserto la fila");
      }
      return {
        pasa: fallos.length === 0,
        detalle: fallos.length === 0 ? detalles.join(" | ") : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "msg-006 con confirmado true y correcciones queda registrado con la fecha exacta del PRD",
    correr: async () => {
      const salida = await registrarMensaje("msg-006", true, {
        valor: 0,
        fecha_fin: "2027-08-31",
      });
      const fila = filaCopia("CM-2026-03");
      const fallos: string[] = [];
      if (salida.accion !== "nuevo") {
        fallos.push(`accion=${salida.accion}`);
      }
      if (fila === null) {
        fallos.push("no se inserto CM-2026-03");
      } else {
        if (fila.fecha_fin !== "2027-08-31") {
          fallos.push(`fecha_fin="${fila.fecha_fin}", el PRD espera 2027-08-31`);
        }
        if (fila.valor !== "0") {
          fallos.push(`valor="${fila.valor}"`);
        }
        // No corregido: sigue sin inventarse.
        if (fila.fecha_inicio !== "") {
          fallos.push(
            `fecha_inicio="${fila.fecha_inicio}": nadie la confirmo, no debe inventarse`,
          );
        }
        if (fila.comercial !== "jperez@periferia-ficticia.com") {
          fallos.push(`comercial=${fila.comercial}, se esperaba el email`);
        }
      }
      if (salida.archivado?.origen !== "clausula_firma") {
        fallos.push(`origen del anio=${salida.archivado?.origen ?? "(ninguno)"}`);
      }
      if (salida.archivado?.anio !== "2026") {
        fallos.push(`anio=${salida.archivado?.anio ?? "(ninguno)"}`);
      }
      if (salida.correcciones.length !== 2) {
        fallos.push(`correcciones=${salida.correcciones.length}`);
      }
      // Los campos corregidos salen de revision; los otros cuatro siguen.
      const sinCorregir = [...salida.revision_sin_corregir].sort();
      const esperados = [
        "fecha_inicio",
        "moneda",
        "requiere_poliza",
        "tipo_poliza",
      ];
      if (JSON.stringify(sinCorregir) !== JSON.stringify(esperados)) {
        fallos.push(`revision_sin_corregir=[${sinCorregir.join(", ")}]`);
      }
      if (
        salida.procedencia.fecha_fin !== "humano" ||
        salida.procedencia.valor !== "humano" ||
        salida.procedencia.cliente !== "documento"
      ) {
        fallos.push(
          `procedencia mal: fecha_fin=${salida.procedencia.fecha_fin} valor=${salida.procedencia.valor} cliente=${salida.procedencia.cliente}`,
        );
      }
      if (salida.comercial_resuelto !== false || salida.aviso === null) {
        fallos.push("no se reporto el remitente no resuelto");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `${salida.ruta_archivo} | ${salida.archivado?.explicacion ?? ""} | ${salida.resumen_procedencia}`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "historial.jsonl distingue los campos aportados por el humano, con su valor",
    correr: () => {
      const linea = lineasHistorial().find(
        (fila) => fila.mensaje_id === "msg-006",
      );
      if (linea === undefined) {
        return { pasa: false, detalle: "no hay linea de historial de msg-006" };
      }
      const correcciones = linea.correcciones;
      const fallos: string[] = [];
      if (!Array.isArray(correcciones) || correcciones.length !== 2) {
        fallos.push("la linea no lista las dos correcciones");
      } else {
        const serializado = JSON.stringify(correcciones);
        if (!serializado.includes("2027-08-31")) {
          fallos.push("no guarda el valor exacto aportado");
        }
        if (!serializado.includes("fecha_fin")) {
          fallos.push("no nombra el campo corregido");
        }
      }
      const procedencia = linea.procedencia;
      if (
        typeof procedencia !== "object" ||
        procedencia === null ||
        (procedencia as Record<string, unknown>).fecha_fin !== "humano" ||
        (procedencia as Record<string, unknown>).nit_cliente !== "documento"
      ) {
        fallos.push("la procedencia por columna no viaja en el historial");
      }
      if (!Array.isArray(linea.revision_sin_corregir)) {
        fallos.push("no registra que quedo sin corregir");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `correcciones=${JSON.stringify(correcciones)} | fecha_fin=humano, nit_cliente=documento | sin corregir: ${JSON.stringify(linea.revision_sin_corregir)}`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "msg-005 rechazado NO escribe nada, ni el maestro ni procesados (RN4)",
    correr: async () => {
      const antesFixtures = huella("fixtures");
      const antesOut = huella("out");
      const sobre = await invocarCrudo("contratos_registrar", {
        mensaje_id: "msg-005",
        confirmado: true,
        hoy: HOY,
        comprobante: comprobanteVivo("msg-005"),
      });
      const fallos: string[] = [];
      if (sobre.ok !== false) {
        fallos.push("un rechazado deberia devolver sobre de error");
      }
      if (typeof sobre.error !== "string" || !sobre.error.includes("RECHAZADO")) {
        fallos.push(`el error no lo explica: ${sobre.error ?? ""}`);
      }
      if (huella("fixtures") !== antesFixtures) {
        fallos.push("el arbol fixtures/ cambio");
      }
      if (huella("out") !== antesOut) {
        fallos.push("el arbol out/ cambio: ni procesados.json debe tocarse");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `confirmado=true y aun asi 0 escrituras; ni siquiera procesados.json | ${(sobre.error ?? "").slice(0, 100)}`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo: "tras registrar, leer_buzon ya no lista los mensajes procesados",
    correr: async () => {
      const datos = esquemaBuzon.parse(
        await invocar("contratos_leer_buzon", {}),
      );
      const ids = datos.mensajes.map((mensaje) => mensaje.id);
      // Solo msg-001, msg-003 y msg-006 quedaron procesados.
      // msg-004 (duplicado) y msg-005 (rechazado) no escriben nada, ni
      // siquiera procesados.json, asi que siguen apareciendo. Ver S-27.
      const esperados = ["msg-002", "msg-004", "msg-005"];
      const pasa = JSON.stringify(ids) === JSON.stringify(esperados);
      return {
        pasa,
        detalle: `quedan [${ids.join(", ")}], se esperaba [${esperados.join(", ")}]`,
      };
    },
  },
  {
    titulo:
      "la ruta del archivo copiado existe en disco y coincide con la de la fila",
    correr: () => {
      const fallos: string[] = [];
      const detalles: string[] = [];
      for (const id of ["CT-2026-015", "CT-2026-011", "CM-2026-03"]) {
        const fila = filaCopia(id);
        if (fila === null) {
          fallos.push(`${id}: no esta en la copia`);
          continue;
        }
        const ruta = fila.ruta_sharepoint ?? "";
        if (!ruta.startsWith("Contratos/")) {
          fallos.push(`${id}: ruta "${ruta}" no tiene la forma esperada`);
          continue;
        }
        const enDisco = join(RAIZ_SHAREPOINT, ...ruta.split("/"));
        if (!existsSync(enDisco)) {
          fallos.push(`${id}: la fila apunta a "${ruta}" y el archivo no existe`);
          continue;
        }
        detalles.push(ruta);
      }
      return {
        pasa: fallos.length === 0,
        detalle: fallos.length === 0 ? detalles.join(" | ") : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "registrar dos veces el mismo mensaje es un no-op: ya_procesado, sin escrituras",
    correr: async () => {
      const antesOut = huella("out");
      const salida = await registrarMensaje("msg-001", false);
      const fallos: string[] = [];
      if (salida.accion !== "ya_procesado") {
        fallos.push(`accion=${salida.accion}`);
      }
      if (salida.escrituras.length !== 0) {
        fallos.push(`declaro ${salida.escrituras.length} escrituras`);
      }
      if (huella("out") !== antesOut) {
        fallos.push("el arbol out/ cambio");
      }
      if (
        lineasHistorial().filter((fila) => fila.mensaje_id === "msg-001")
          .length !== 1
      ) {
        fallos.push("duplico la linea del historial");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `ok:true sin escrituras, historial con una sola linea de msg-001 | ${salida.aviso ?? ""}`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "cada campo de args lleva .describe(): el PRD lo exige y nada lo comprobaba",
    correr: () => {
      const fallos: string[] = [];
      let camposRevisados = 0;
      for (const declaracion of declarar(REGISTRO_AGENTE)) {
        const esquema = declaracion.input_schema;
        const propiedades = esquema["properties"];
        if (typeof propiedades !== "object" || propiedades === null) {
          // Sin propiedades es legitimo: leer_buzon no recibe argumentos.
          continue;
        }
        for (const [campo, definicion] of Object.entries(
          propiedades as Record<string, unknown>,
        )) {
          camposRevisados += 1;
          if (typeof definicion !== "object" || definicion === null) {
            fallos.push(`${declaracion.name}.${campo}: definicion ilegible`);
            continue;
          }
          const descripcion = (definicion as Record<string, unknown>)[
            "description"
          ];
          if (typeof descripcion !== "string" || descripcion.trim() === "") {
            fallos.push(`${declaracion.name}.${campo}: sin .describe()`);
          }
        }
      }
      if (camposRevisados === 0) {
        fallos.push("no se reviso ni un campo: la verificacion no prueba nada");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `${camposRevisados} campos de argumentos, todos con descripcion, en las ${declarar(REGISTRO_AGENTE).length} herramientas`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "la similitud de objeto: iguales da 1, distintos da poco, y el par real no llega al umbral",
    correr: () => {
      const fallos: string[] = [];

      // Caso 1: identicos.
      const iguales = similitud(
        "Mesa de servicio TI nivel 1 y 2",
        "Mesa de servicio TI nivel 1 y 2",
      );
      if (iguales !== 1) {
        fallos.push(`iguales=${iguales}, se esperaba 1`);
      }
      // Y con distinta capitalizacion y tildes: la normalizacion existe
      // para que la metrica este definida, no para cerrar brechas.
      const mismosOtraForma = similitud(
        "Mesa de servicio TI nivel 1 y 2",
        "  MESA DE SERVICIO TI NIVEL 1 Y 2.  ",
      );
      if (mismosOtraForma !== 1) {
        fallos.push(`mismo texto con otra forma=${mismosOtraForma}`);
      }

      // Caso 2: claramente distintos.
      const distintos = similitud(
        "Mesa de servicio TI nivel 1 y 2",
        "Suministro de vehiculos blindados para transporte de valores",
      );
      if (distintos >= 0.3) {
        fallos.push(`distintos=${distintos}, deberia ser bajo`);
      }
      if (distintos >= UMBRAL_SIMILITUD) {
        fallos.push("dos objetos sin relacion superan el umbral");
      }

      // Caso 3: el par REAL. msg-004 contra su fila del maestro, que es el
      // unico par comparable de los fixtures.
      const extraido = extraccion("msg-004").campos.objeto.valor;
      const fila = leerMaestro().filas.find(
        (una) => una.id_contrato === "CT-2026-012",
      );
      const enMaestro = fila?.objeto ?? "";
      if (typeof extraido !== "string" || enMaestro === "") {
        return { pasa: false, detalle: "no se pudo formar el par real" };
      }
      const real = similitud(extraido, enMaestro);
      if (real >= UMBRAL_SIMILITUD) {
        fallos.push(`el par real da ${real}: contradice lo documentado en S-9`);
      }
      // El numero exacto, fijado para que un cambio en la metrica se note.
      const redondeado = Number(real.toFixed(3));
      if (redondeado !== 0.352) {
        fallos.push(
          `el par real da ${redondeado}, S-9 documenta 0.352: si cambio la metrica, actualiza el supuesto`,
        );
      }

      // Caso 4: un otrosi no da par. Su objeto es no_aplica.
      const otrosi = extraccion("msg-003").campos.objeto;
      if (otrosi.estado !== "no_aplica" || otrosi.valor !== null) {
        fallos.push("el otrosi deberia tener objeto no_aplica");
      }
      if (similitud("", enMaestro) !== 0) {
        fallos.push("comparar contra vacio deberia dar 0, no error");
      }

      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `iguales=1 | sin relacion=${distintos.toFixed(3)} | par real msg-004 vs CT-2026-012=${redondeado} (umbral ${UMBRAL_SIMILITUD}, no dispara) | otrosi: sin objeto que comparar`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "el registro del agente trae las cinco de contratos y ninguna de laboratorio ni ejemplo",
    correr: () => {
      const nombres = declarar(REGISTRO_AGENTE)
        .map((una) => una.name)
        .sort();
      const esperados = [
        "contratos_alertas",
        "contratos_extraer",
        "contratos_leer_buzon",
        "contratos_registrar",
        "contratos_validar",
      ];
      const intrusos = nombres.filter(
        (nombre) =>
          nombre.startsWith("laboratorio_") || nombre.startsWith("ejemplo_"),
      );
      const fallos: string[] = [];
      if (JSON.stringify(nombres) !== JSON.stringify(esperados)) {
        fallos.push(`registro=[${nombres.join(", ")}]`);
      }
      if (intrusos.length > 0) {
        fallos.push(`el modelo veria herramientas de prueba: ${intrusos.join(", ")}`);
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `${nombres.length} herramientas: ${nombres.join(", ")}`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "contratos_registrar exige aprobacion humana y las otras cuatro NO",
    correr: () => {
      const fallos: string[] = [];
      if (!EXIGEN_APROBACION.includes("contratos_registrar")) {
        fallos.push("contratos_registrar NO esta en requierenConfirmacion");
      }
      for (const nombre of [
        "contratos_leer_buzon",
        "contratos_extraer",
        "contratos_validar",
        "contratos_alertas",
      ]) {
        if (EXIGEN_APROBACION.includes(nombre)) {
          fallos.push(`${nombre} no deberia exigir aprobacion`);
        }
      }
      if (EXIGEN_APROBACION.length !== 1) {
        fallos.push(`la lista tiene ${EXIGEN_APROBACION.length} entradas`);
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `requierenConfirmacion = [${EXIGEN_APROBACION.join(", ")}]; las otras cuatro corren solas`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "un turno que pide registrar queda pendiente y la herramienta NO corre: el maestro no cambia",
    correr: async () => {
      // msg-002 sigue sin registrar en este punto de la suite.
      const antesCopia = readFileSync(RUTA_COPIA, "utf8");
      const antesHistorial = lineasHistorial().length;
      const rutaLog = join("out", "prueba-inicio.jsonl");
      rmSync(rutaLog, { force: true });

      const proveedor = new ProveedorFalso(
        [
          {
            tipo: "llamadas",
            llamadas: [
              {
                nombre: "contratos_registrar",
                argumentos: {
                  mensaje_id: "msg-002",
                  confirmado: true,
                  hoy: HOY,
                  comprobante: comprobanteVivo("msg-002"),
                },
              },
            ],
          },
        ],
        { alAgotar: { modo: "texto", texto: "listo" } },
      );

      const turno = await ejecutarTurno({
        adaptador: proveedor,
        registro: REGISTRO_AGENTE,
        historial: [],
        mensajeUsuario: "registra msg-002",
        configuracion: {
          requierenConfirmacion: EXIGEN_APROBACION,
          rutaLog,
        },
      });

      const fallos: string[] = [];
      if (turno.motivoFin !== "confirmacion") {
        fallos.push(`motivoFin=${turno.motivoFin}, se esperaba confirmacion`);
      }
      if (turno.esperandoConfirmacion?.llamada.nombre !== "contratos_registrar") {
        fallos.push("no quedo pendiente contratos_registrar");
      }
      // Verificado por el EFECTO, no por la marca: el maestro no cambio.
      if (readFileSync(RUTA_COPIA, "utf8") !== antesCopia) {
        fallos.push("el maestro cambio pese a que la llamada quedo retenida");
      }
      if (lineasHistorial().length !== antesHistorial) {
        fallos.push("se escribio en el historial");
      }
      if (filaCopia("CT-2026-016") !== null) {
        fallos.push("CT-2026-016 entro en el maestro sin aprobacion");
      }
      if (turno.llamadas[0]?.disposicion !== "pendiente") {
        fallos.push(`disposicion=${turno.llamadas[0]?.disposicion ?? "(ninguna)"}`);
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `motivoFin=confirmacion, disposicion=pendiente, y CT-2026-016 NO esta en el maestro pese a confirmado:true en los argumentos`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "el bloque de aprobacion muestra los campos en prosa, no como volcado JSON",
    correr: async () => {
      const proveedor = new ProveedorFalso(
        [
          {
            tipo: "llamadas",
            llamadas: [
              {
                nombre: "contratos_registrar",
                argumentos: {
                  mensaje_id: "msg-002",
                  confirmado: true,
                  comprobante: "no-importa-queda-retenida",
                  correcciones: { fecha_fin: "2027-08-31" },
                },
              },
            ],
          },
        ],
        { alAgotar: { modo: "texto", texto: "listo" } },
      );
      const turno = await ejecutarTurno({
        adaptador: proveedor,
        registro: REGISTRO_AGENTE,
        historial: [],
        mensajeUsuario: "registra msg-002",
        configuracion: {
          requierenConfirmacion: EXIGEN_APROBACION,
          rutaLog: join("out", "prueba-inicio.jsonl"),
        },
      });
      const texto = turno.respuesta;
      const fallos: string[] = [];
      if (!texto.includes("correcciones.fecha_fin: \"2027-08-31\"")) {
        fallos.push("no muestra el campo anidado en su propia linea");
      }
      if (!texto.includes("mensaje_id: \"msg-002\"")) {
        fallos.push("no muestra mensaje_id campo a campo");
      }
      // La marca de un volcado JSON: llaves y comas pegadas.
      if (texto.includes('{"mensaje_id"') || texto.includes('","')) {
        fallos.push("sigue volcando JSON");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? texto.split("\n").map((linea) => linea.trim()).filter((l) => l !== "").join(" / ")
            : fallos.join("; "),
      };
    },
  },
  {
    titulo: "la linea de out/log.jsonl lleva mensaje_id (RN7)",
    correr: () => {
      const rutaLog = join("out", "prueba-inicio.jsonl");
      if (!existsSync(rutaLog)) {
        return { pasa: false, detalle: "no se escribio el log de la prueba" };
      }
      const lineas = readFileSync(rutaLog, "utf8")
        .split("\n")
        .filter((linea) => linea.trim() !== "")
        .map((linea) => {
          const analizado: unknown = JSON.parse(linea);
          return typeof analizado === "object" && analizado !== null
            ? (analizado as Record<string, unknown>)
            : {};
        });
      const fallos: string[] = [];
      const exigidas = ["ts", "herramienta", "mensaje_id", "ok", "resumen"];
      for (const linea of lineas) {
        for (const clave of exigidas) {
          if (!(clave in linea)) {
            fallos.push(`falta ${clave} en una linea`);
          }
        }
        if (linea.mensaje_id !== "msg-002") {
          fallos.push(`mensaje_id=${JSON.stringify(linea.mensaje_id)}`);
        }
        // Lo nuestro, que conservamos.
        if (!("disposicion" in linea) || !("clase" in linea)) {
          fallos.push("se perdieron disposicion o clase");
        }
      }
      rmSync(rutaLog, { force: true });
      return {
        pasa: fallos.length === 0 && lineas.length > 0,
        detalle:
          fallos.length === 0
            ? `${lineas.length} lineas con {ts, herramienta, mensaje_id, ok, resumen} + disposicion y clase | mensaje_id="${String(lineas[0]?.mensaje_id)}"`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "el fixture completo es identico antes y despues de toda la suite, por huella",
    correr: () => {
      const ahora = huella("fixtures");
      const pasa = ahora === HUELLA_FIXTURES_INICIAL;
      return {
        pasa,
        detalle: pasa
          ? `${ahora.split("\n").length} archivos con ruta, tamano y mtime identicos a los del arranque, tras ${IDS.length} registros`
          : "el arbol fixtures/ cambio durante la suite",
      };
    },
  },
  {
    titulo:
      "registrar SIN pasar por validar se rechaza: sin comprobante y con uno falso",
    correr: async () => {
      const antesFixtures = huella("fixtures");
      const antesOut = huella("out");
      const fallos: string[] = [];
      const detalles: string[] = [];

      // msg-002 sigue sin registrar y su veredicto es "nuevo": el camino
      // que de verdad escribiria si no hubiera guarda.
      const sinNada = await invocarCrudo("contratos_registrar", {
        mensaje_id: "msg-002",
        confirmado: true,
        hoy: HOY,
      });
      if (sinNada.ok !== false) {
        fallos.push("sin comprobante deberia rechazar");
      } else if (!(sinNada.error ?? "").includes("contratos_validar")) {
        fallos.push("el error no dice que hay que validar primero");
      } else {
        detalles.push("sin comprobante: rechazado");
      }

      const inventado = await invocarCrudo("contratos_registrar", {
        mensaje_id: "msg-002",
        confirmado: true,
        hoy: HOY,
        comprobante: "0123456789abcdef",
      });
      if (inventado.ok !== false) {
        fallos.push("un comprobante inventado deberia rechazar");
      } else {
        detalles.push("comprobante inventado: rechazado");
      }

      // El de OTRO mensaje tampoco vale.
      const ajeno = await invocarCrudo("contratos_registrar", {
        mensaje_id: "msg-002",
        confirmado: true,
        hoy: HOY,
        comprobante: comprobanteVivo("msg-001"),
      });
      if (ajeno.ok !== false) {
        fallos.push("el comprobante de otro mensaje deberia rechazar");
      } else {
        detalles.push("comprobante de otro mensaje: rechazado");
      }

      // Verificado por el efecto: nada se escribio en ninguno de los tres.
      if (huella("fixtures") !== antesFixtures) {
        fallos.push("el arbol fixtures/ cambio");
      }
      if (huella("out") !== antesOut) {
        fallos.push("el arbol out/ cambio");
      }
      if (filaCopia("CT-2026-016") !== null) {
        fallos.push("CT-2026-016 entro en el maestro sin pasar por validar");
      }

      // Y con el comprobante bueno SI escribe: la guarda no bloquea el
      // camino legitimo.
      const bueno = await registrarMensaje("msg-002", false);
      if (bueno.accion !== "nuevo") {
        fallos.push(`con comprobante valido: accion=${bueno.accion}`);
      } else {
        detalles.push("con el comprobante de validar: registrado");
      }

      return {
        pasa: fallos.length === 0,
        detalle: fallos.length === 0 ? detalles.join(" | ") : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "el pendiente que viaja a la API lleva los campos ya aplanados, no JSON",
    correr: () => {
      const campos = camposDeArgumentos({
        mensaje_id: "msg-006",
        confirmado: true,
        correcciones: { valor: 0, fecha_fin: "2027-08-31" },
      });
      const plano = campos.map((una) => `${una.campo}=${una.valor}`);
      const fallos: string[] = [];
      const esperados = [
        'mensaje_id="msg-006"',
        "confirmado=true",
        "correcciones.valor=0",
        'correcciones.fecha_fin="2027-08-31"',
      ];
      if (JSON.stringify(plano) !== JSON.stringify(esperados)) {
        fallos.push(`campos=[${plano.join(", ")}]`);
      }
      // El front recibe esto y lo pinta tal cual; el fallo anterior fue
      // que formateaba el objeto crudo por su cuenta.
      const html = readFileSync(join("web", "index.html"), "utf8");
      if (html.includes("JSON.stringify(valor, null, 2)")) {
        fallos.push("el front sigue volcando JSON en el bloque destacado");
      }
      if (!html.includes("accion-campos")) {
        fallos.push("el front no pinta la lista de campos");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? plano.join(" | ")
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "una fila que no cumple el esquema 7.2 se rechaza y no se escribe",
    correr: () => {
      const base = leerMaestro().filas.find(
        (una) => una.id_contrato === "CT-2026-015",
      );
      if (base === undefined) {
        return { pasa: false, detalle: "no hay fila de la que partir" };
      }
      if (validarFilaContraEsquema(base).length !== 0) {
        return {
          pasa: false,
          detalle: "la fila real ya incumple el esquema: premisa rota",
        };
      }
      const fallos: string[] = [];
      const casos: readonly [string, Record<string, string>, string][] = [
        ["moneda fuera del enum", { moneda: "EUROS" }, "moneda"],
        ["pais fuera del enum", { pais: "XX" }, "pais"],
        ["fecha con formato malo", { fecha_fin: "31/08/2027" }, "fecha_fin"],
        ["fecha inexistente", { fecha_fin: "2027-02-31" }, "fecha_fin"],
        ["valor con separadores", { valor: "265.000.000" }, "valor"],
        ["booleano que no lo es", { requiere_poliza: "quiza" }, "requiere_poliza"],
        ["estado_poliza inventado", { estado_poliza: "tramitando" }, "estado_poliza"],
        ["id_contrato vacio", { id_contrato: "" }, "id_contrato"],
        ["objeto de 201 caracteres", { objeto: "x".repeat(201) }, "objeto"],
      ];
      for (const [nombre, parche, columnaEsperada] of casos) {
        const problemas = validarFilaContraEsquema({ ...base, ...parche });
        if (problemas.length === 0) {
          fallos.push(`${nombre}: se acepto`);
        } else if (!problemas.some((uno) => uno.columna === columnaEsperada)) {
          fallos.push(`${nombre}: culpa a la columna equivocada`);
        }
      }
      // Y lo que SI debe pasar: celdas vacias donde el dato no se
      // determino. Sin esto msg-006 no podria registrarse nunca (S-29).
      const conVacios = { ...base, moneda: "", fecha_inicio: "", objeto: "" };
      if (validarFilaContraEsquema(conVacios).length !== 0) {
        fallos.push(
          "una celda vacia en un campo no determinado deberia permitirse",
        );
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `${casos.length} formas invalidas rechazadas, cada una culpando a su columna; celdas vacias permitidas en campos no determinados`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "el objeto se recorta a los 200 caracteres que fija el esquema 7.2",
    correr: () => {
      const fila = filaCopia("CM-2026-03");
      const completo = extraccion("msg-006").campos.objeto.valor;
      const fallos: string[] = [];
      if (fila === null) {
        return { pasa: false, detalle: "CM-2026-03 no esta en la copia" };
      }
      const escrito = fila.objeto ?? "";
      if (typeof completo !== "string") {
        fallos.push("la extraccion no trae objeto");
      } else if (completo.length <= 200) {
        fallos.push("el caso no ejercita el recorte: el objeto ya cabia");
      }
      if (escrito.length > 200) {
        fallos.push(`se escribieron ${escrito.length} caracteres`);
      }
      if (!escrito.endsWith("…")) {
        fallos.push("el recorte no se senaliza");
      }
      // El texto completo NO se pierde: sigue en la extraccion.
      if (typeof completo === "string" && !completo.startsWith(escrito.slice(0, 40))) {
        fallos.push("el recorte no es prefijo del original");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `extraido ${String(completo).length} car -> escrito ${escrito.length} car, cortado por palabra entera; el texto integro sigue en la extraccion y el historial`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "marcar un procesado CONSERVA el historial previo, tambien en la forma {procesados:[...]}",
    correr: () => {
      const original = existsSync(RUTA_PROCESADOS)
        ? readFileSync(RUTA_PROCESADOS, "utf8")
        : null;
      const fallos: string[] = [];
      try {
        // La forma que el lector acepta y el escritor descartaba: raiz
        // objeto con la clave "procesados". Antes del arreglo, la
        // siguiente escritura borraba estas dos entradas en silencio.
        writeFileSync(
          RUTA_PROCESADOS,
          JSON.stringify(
            {
              procesados: [
                {
                  mensaje_id: "msg-901",
                  id_contrato: "CT-9001",
                  accion: "nuevo",
                  ts: "2026-01-01T00:00:00.000Z",
                },
                "msg-902",
              ],
            },
            null,
            2,
          ),
          "utf8",
        );
        const fallo = marcarProcesado(
          "msg-903",
          "CT-9003",
          "nuevo",
          "2026-09-03T00:00:00.000Z",
        );
        if (fallo !== null) {
          fallos.push(`no deberia fallar con forma valida: ${fallo}`);
        }
        const despues = leerProcesadosDeDisco();
        const ids = despues.entradas.map((una) => una.mensaje_id).sort();
        if (
          JSON.stringify(ids) !==
          JSON.stringify(["msg-901", "msg-902", "msg-903"])
        ) {
          fallos.push(`quedaron [${ids.join(", ")}]: se perdio historial`);
        }
        const rica = despues.entradas.find(
          (una) => una.mensaje_id === "msg-901",
        );
        if (rica?.id_contrato !== "CT-9001" || rica.accion !== "nuevo") {
          fallos.push("se aplanaron los campos de la entrada previa");
        }

        // Un archivo ilegible NO se sobrescribe: destruirlo seria
        // exactamente el fallo que se esta arreglando.
        const corrupto = "{ esto no es json";
        writeFileSync(RUTA_PROCESADOS, corrupto, "utf8");
        const falloCorrupto = marcarProcesado("msg-904", null, "nuevo", "x");
        if (falloCorrupto === null) {
          fallos.push("con el archivo corrupto deberia avisar, no callar");
        }
        if (readFileSync(RUTA_PROCESADOS, "utf8") !== corrupto) {
          fallos.push("sobrescribio un archivo que no entendia");
        }
      } finally {
        if (original === null) {
          rmSync(RUTA_PROCESADOS, { force: true });
        } else {
          writeFileSync(RUTA_PROCESADOS, original, "utf8");
        }
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? "forma {procesados:[...]} leida y conservada con todos sus campos; un archivo ilegible se reporta y no se sobrescribe"
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "el flujo completo no escribe NADA fuera de out\: huella del arbol del proyecto",
    correr: async () => {
      // Invariante de seguridad central del reto. Hasta ahora se sostenia
      // por razonamiento; esto lo mide.
      const vigilados = [
        "fixtures",
        "src",
        "web",
        "agent",
        "knowledge",
        "package.json",
        "tsconfig.json",
        "demo.ts",
        "prueba-contratos.ts",
      ];
      const antes = vigilados.map((ruta) => `${ruta}
${huella(ruta)}`);
      const antesRaiz = readdirSync(".", { withFileTypes: true })
        .map((entrada) => `${entrada.name}${entrada.isDirectory() ? "/" : ""}`)
        .sort()
        .join(" ");

      // El flujo entero, de punta a punta.
      await invocar("contratos_leer_buzon", {});
      for (const id of IDS) {
        await invocar("contratos_extraer", { mensaje_id: id });
        await invocar("contratos_validar", { mensaje_id: id });
        await invocarCrudo("contratos_registrar", {
          mensaje_id: id,
          confirmado: true,
          hoy: HOY,
          comprobante: comprobanteVivo(id),
        });
      }
      await invocar("contratos_alertas", { hoy: HOY });

      const fallos: string[] = [];
      vigilados.forEach((ruta, indice) => {
        if (`${ruta}
${huella(ruta)}` !== antes[indice]) {
          fallos.push(`cambio ${ruta}`);
        }
      });
      const despuesRaiz = readdirSync(".", { withFileTypes: true })
        .map((entrada) => `${entrada.name}${entrada.isDirectory() ? "/" : ""}`)
        .sort()
        .join(" ");
      if (antesRaiz !== despuesRaiz) {
        fallos.push("aparecieron o desaparecieron entradas en la raiz");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `${vigilados.length} rutas del proyecto intactas tras leer, extraer, validar, registrar y alertar los ${IDS.length} mensajes; la raiz no gano ni perdio entradas`
            : fallos.join("; "),
      };
    },
  },
  {
    // Va la ultima a proposito: demo.ts limpia out\ al arrancar.
    titulo: "demo.ts corre entero sin clave ni red y termina con codigo cero",
    correr: () => {
      const previa = process.env["OPENAI_API_KEY"];
      delete process.env["OPENAI_API_KEY"];
      const salida = spawnSync(
        process.execPath,
        ["--import", "tsx", "demo.ts"],
        { encoding: "utf8", env: { ...process.env } },
      );
      if (previa !== undefined) {
        process.env["OPENAI_API_KEY"] = previa;
      }
      const texto = `${salida.stdout ?? ""}${salida.stderr ?? ""}`;
      const fallos: string[] = [];
      if (salida.status !== 0) {
        fallos.push(`codigo de salida ${String(salida.status)}`);
      }
      for (const exigido of [
        "NO SE ESCRIBIO NADA",
        "confirmo el valor 0 y la fecha fin 2027-08-31",
        "Reporte de alertas con fecha de corte 2026-09-03",
        "nuevo (tras aprobacion)",
      ]) {
        if (!texto.includes(exigido)) {
          fallos.push(`la salida no contiene "${exigido}"`);
        }
      }
      if (/OPENAI_API_KEY|clave|api[_-]?key/iu.test(salida.stderr ?? "")) {
        fallos.push("se quejo por falta de clave");
      }
      return {
        pasa: fallos.length === 0,
        detalle:
          fallos.length === 0
            ? `codigo 0, ${texto.split("\n").length} lineas; msg-006 sin registrar en la primera pasada y registrado en la segunda`
            : fallos.join("; "),
      };
    },
  },
  {
    titulo:
      "el fixture maestro-contratos.csv no se modifica: contenido antes y despues",
    correr: async () => {
      const antes = readFileSync(RUTA_MAESTRO, "utf8");
      const antesInfo = statSync(RUTA_MAESTRO);
      await invocar("contratos_leer_buzon", {});
      for (const id of IDS) {
        await invocar("contratos_extraer", { mensaje_id: id });
        await invocar("contratos_validar", { mensaje_id: id });
      }
      const despues = readFileSync(RUTA_MAESTRO, "utf8");
      const despuesInfo = statSync(RUTA_MAESTRO);
      const pasa =
        antes === despues && antesInfo.mtimeMs === despuesInfo.mtimeMs;
      return {
        pasa,
        detalle: `${antes.length} bytes antes, ${despues.length} despues, mtime ${antesInfo.mtimeMs === despuesInfo.mtimeMs ? "intacto" : "CAMBIADO"}`,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Corrida
// ---------------------------------------------------------------------------

async function principal(): Promise<void> {
  // contratos_registrar escribe: la suite parte de cero para que sea
  // repetible. Lo borra el arnes, no ninguna herramienta.
  limpiarSalida();
  console.log(
    `(arranque limpio: se borraron ${RAIZ_SHAREPOINT} y ${RUTA_PROCESADOS} si existian)`,
  );
  console.log("");

  let pasan = 0;
  for (const [indice, verificacion] of verificaciones.entries()) {
    let resultado: Resultado;
    try {
      resultado = await verificacion.correr();
    } catch (causa: unknown) {
      resultado = {
        pasa: false,
        detalle: `excepcion: ${causa instanceof Error ? causa.message : String(causa)}`,
      };
    }
    if (resultado.pasa) {
      pasan += 1;
    }
    console.log(
      `${indice + 1}. ${resultado.pasa ? "PASA" : "FALLA"} - ${verificacion.titulo}`,
    );
    console.log(`   ${resultado.detalle}`);
  }

  console.log("");
  console.log(`${pasan} de ${verificaciones.length} verificaciones pasan`);

  if (pasan !== verificaciones.length) {
    process.exitCode = 1;
  }
}

await principal();
