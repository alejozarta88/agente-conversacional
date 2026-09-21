import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { z } from "zod";
import { definir, respuestaError, respuestaOk } from "./contrato.js";

/**
 * Reto 02 - Registro de contratos vigentes. Las CINCO herramientas del
 * dominio.
 *
 * | herramienta          | escribe | exige aprobacion humana |
 * |----------------------|---------|-------------------------|
 * | contratos_leer_buzon | no      | no                      |
 * | contratos_extraer    | no      | no                      |
 * | contratos_validar    | no      | no                      |
 * | contratos_registrar  | SI      | SI                      |
 * | contratos_alertas    | si*     | no                      |
 *
 * (*) alertas escribe out/alertas.md y nada mas: no toca el maestro, ni el
 * historial, ni procesados. Generar un reporte no cambia datos del
 * negocio y es idempotente, por eso no se detiene a pedir aprobacion.
 *
 * `contratos_registrar` es la unica que modifica datos del negocio, la
 * unica que entra en requierenConfirmacion y la unica que copia el fixture
 * a out/sharepoint (RN6). **El fixture nunca se modifica**: solo se lee y,
 * una vez, se copia.
 *
 * La extraccion es DETERMINISTA: regex y heuristicas cerradas sobre el
 * texto del adjunto. El modelo no participa. Un campo que no esta en el
 * texto sale null con confianza 0; nunca se infiere a un valor plausible.
 */

const RAIZ_BUZON = join("fixtures", "reto-02", "buzon");
const RUTA_PROCESADOS = join("out", "procesados.json");
const RUTA_COMERCIALES = join("fixtures", "reto-02", "comerciales.json");

/**
 * El maestro vivo esta en out/sharepoint/ una vez que registrar lo copia
 * (RN6). Mientras no exista se lee el fixture, que es de solo lectura:
 * esta herramienta NO lo copia, solo lo lee.
 */
const RAIZ_SHAREPOINT = join("out", "sharepoint");
const RUTA_MAESTRO_SHAREPOINT = join(RAIZ_SHAREPOINT, "maestro-contratos.csv");
const RUTA_MAESTRO_FIXTURE = join("fixtures", "reto-02", "maestro-contratos.csv");
const RUTA_HISTORIAL = join(RAIZ_SHAREPOINT, "historial.jsonl");
const CARPETA_CONTRATOS = "Contratos";
const RUTA_ALERTAS = join("out", "alertas.md");

/** Ventana de vencimiento que fija HU-5. */
const VENTANA_DIAS = 60;
/** Inicio del gap que el proyecto existe para cerrar (HU-5). */
const CORTE_GAP = "2026-05-30";

/** Orden exacto de columnas del maestro. */
const COLUMNAS_MAESTRO: readonly string[] = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
  "estado_poliza",
  "comercial",
  "ruta_sharepoint",
  "fecha_registro",
  "fuente",
];

// ---------------------------------------------------------------------------
// Escala de confianza
// ---------------------------------------------------------------------------

/**
 * Escala discreta de cinco escalones. No hay valores intermedios: un 0.73
 * no le dice nada a quien revisa y finge una precision que el regex no
 * tiene.
 *
 * 1.0 literal      literal y univoco, sin normalizacion
 * 0.9 determinista respuesta unica: literal en clausula rotulada, o regla
 *                  cerrada sobre el texto (pais por formato del id
 *                  tributario, requiere_poliza false por ausencia de
 *                  clausula de garantias, nit normalizado)
 * 0.6 derivado     pudo salir distinto: fecha_fin calculada desde un plazo
 *                  en meses cuando no hay fecha literal
 * 0.3 parcial      el texto habla del campo y no lo fija
 * 0.0 ausente      no esta en el texto -> el valor es null
 *
 * El salto que importa es 0.9 -> 0.6: 0.9 significa "esto esta en el
 * documento", 0.6 significa "esto lo calcule yo a partir del documento".
 * Quien revisa puede saltarse los 0.9 y debe leer los 0.6.
 */
export const CONFIANZA = {
  literal: 1,
  determinista: 0.9,
  derivado: 0.6,
  parcial: 0.3,
  ausente: 0,
} as const;

/** RN5: por debajo de este corte el campo entra en requiere_revision. */
export const CORTE_REVISION = 0.8;

/**
 * Estado de un campo. Mapea 1:1 contra la escala, salvo no_aplica.
 *
 * no_aplica NO es baja confianza: es que este TIPO de documento no trae
 * ese campo. Un otrosi no tiene objeto propio porque el contrato original
 * lo conserva, no porque no se pudo leer. Por eso queda fuera de RN5.
 */
export type EstadoCampo =
  | "leido"
  | "deducido"
  | "derivado"
  | "parcial"
  | "ausente"
  | "no_aplica"
  /** Lo aporto una persona, no el documento. Ver confirmado() y S-20. */
  | "confirmado";

export type ValorCampo = string | number | boolean;

export interface Campo {
  valor: ValorCampo | null;
  confianza: number;
  estado: EstadoCampo;
  /** Por que este valor y esta confianza. null cuando es literal y obvio. */
  nota: string | null;
}

function literal(valor: ValorCampo, nota: string | null = null): Campo {
  return { valor, confianza: CONFIANZA.literal, estado: "leido", nota };
}

function normalizado(valor: ValorCampo, nota: string): Campo {
  return { valor, confianza: CONFIANZA.determinista, estado: "leido", nota };
}

function deducido(valor: ValorCampo | null, nota: string): Campo {
  return { valor, confianza: CONFIANZA.determinista, estado: "deducido", nota };
}

function derivado(valor: ValorCampo, nota: string): Campo {
  return { valor, confianza: CONFIANZA.derivado, estado: "derivado", nota };
}

function parcial(valor: ValorCampo | null, nota: string): Campo {
  return { valor, confianza: CONFIANZA.parcial, estado: "parcial", nota };
}

function ausente(nota: string): Campo {
  return { valor: null, confianza: CONFIANZA.ausente, estado: "ausente", nota };
}

/**
 * Valor aportado por una persona a traves de `correcciones`.
 *
 * La confianza vale 0.9 y ese numero NO es una medicion. La escala de
 * arriba ordena proximidad al documento: 1.0 es "esta escrito ahi, literal
 * y sin normalizar". Un valor confirmado tiene proximidad CERO al
 * documento, porque el documento no lo dice; es evidencia de otra especie.
 * No le corresponde ningun escalon de esa escala.
 *
 * El 0.9 esta puesto solo para que el campo cruce el corte de RN5 y deje
 * de bloquear el registro, que es lo que el humano decidio al confirmar.
 * La senal que de verdad informa es `estado: "confirmado"` y la
 * procedencia de la fila, no el numero. Ver S-20.
 */
function confirmado(valor: ValorCampo, nota: string): Campo {
  return {
    valor,
    confianza: CONFIANZA.determinista,
    estado: "confirmado",
    nota,
  };
}

function noAplica(nota: string): Campo {
  return {
    valor: null,
    confianza: CONFIANZA.ausente,
    estado: "no_aplica",
    nota,
  };
}

// ---------------------------------------------------------------------------
// Esquema del maestro y tipos de documento
// ---------------------------------------------------------------------------

/** Los 11 campos que se leen del contrato. Los otros 5 del maestro son
 *  metadatos de registro y no viven en el documento. */
export const NOMBRES_CAMPO = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
] as const;

export type NombreCampo = (typeof NOMBRES_CAMPO)[number];

export type TipoDocumento =
  | "contrato"
  | "contrato_marco"
  | "otrosi"
  | "cotizacion"
  | "desconocido";

/** Los tipos que cuentan como materia contractual. */
const TIPOS_CONTRACTUALES: readonly TipoDocumento[] = [
  "contrato",
  "contrato_marco",
  "otrosi",
];

/**
 * Campos que cada TIPO de documento no trae, declarados por adelantado.
 *
 * Esta tabla es la guarda de no_aplica: la exclusion de RN5 se decide por
 * tipo de documento, nunca campo por campo mirando el texto. Si se
 * decidiera caso por caso seria la puerta trasera de RN5, porque cualquier
 * campo ilegible podria disfrazarse de inaplicable.
 */
const CAMPOS_NO_APLICA: Readonly<Record<TipoDocumento, readonly NombreCampo[]>> =
  {
    contrato: [],
    contrato_marco: [],
    // Un otrosi modifica clausulas puntuales; "las demas permanecen sin
    // modificacion". El objeto y la fecha de inicio los conserva el
    // contrato original, y es lo que RN2 necesita para actualizar la fila
    // en vez de reemplazarla.
    otrosi: ["objeto", "fecha_inicio"],
    cotizacion: [],
    desconocido: [],
  };

// ---------------------------------------------------------------------------
// Utilidades de texto
// ---------------------------------------------------------------------------

const ORDINALES =
  "PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|S[EÉ]PTIMA|OCTAVA|NOVENA|D[EÉ]CIMA";

function espacios(texto: string): string {
  return texto.replace(/\s+/gu, " ").trim();
}

/** Texto de una clausula rotulada: "SEGUNDA. VALOR. <cuerpo>". */
function clausula(texto: string, etiqueta: string): string | null {
  const encabezado = new RegExp(`(?:${ORDINALES})\\.\\s*${etiqueta}\\.`, "iu");
  const inicio = encabezado.exec(texto);
  if (inicio === null) {
    return null;
  }
  const resto = texto.slice(inicio.index + inicio[0].length);
  const corte = new RegExp(`\\n\\s*\\n|(?:${ORDINALES})\\.`, "u").exec(resto);
  return espacios(corte === null ? resto : resto.slice(0, corte.index));
}

/**
 * Texto de una clausula de otrosi, que no rotula sino que cita:
 * "SEGUNDA. Modificar la clausula SEGUNDA (VALOR), la cual quedara asi: ...".
 */
function clausulaOtrosi(texto: string, etiqueta: string): string | null {
  const encabezado = new RegExp(
    `(?:${ORDINALES})\\.[^\\n]*?\\(${etiqueta}\\)`,
    "iu",
  );
  const inicio = encabezado.exec(texto);
  if (inicio === null) {
    return null;
  }
  const resto = texto.slice(inicio.index + inicio[0].length);
  const corte = new RegExp(`\\n\\s*\\n|(?:${ORDINALES})\\.`, "u").exec(resto);
  return espacios(corte === null ? resto : resto.slice(0, corte.index));
}

function segmento(
  texto: string,
  tipo: TipoDocumento,
  etiqueta: string,
): string | null {
  return tipo === "otrosi"
    ? clausulaOtrosi(texto, etiqueta)
    : clausula(texto, etiqueta);
}

const MESES: Readonly<Record<string, string>> = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  setiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
};

function aIso(dia: string, mes: string, anio: string): string | null {
  const numeroMes = MESES[mes.toLowerCase()];
  if (numeroMes === undefined) {
    return null;
  }
  return `${anio}-${numeroMes}-${dia.padStart(2, "0")}`;
}

/** Suma meses a una fecha ISO sin salirse del calendario. */
function sumarMeses(iso: string, meses: number): string {
  const base = new Date(`${iso}T00:00:00Z`);
  const dia = base.getUTCDate();
  base.setUTCDate(1);
  base.setUTCMonth(base.getUTCMonth() + meses);
  const ultimo = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0),
  ).getUTCDate();
  base.setUTCDate(Math.min(dia, ultimo));
  const salida = base.toISOString().slice(0, 10);
  return salida;
}

// ---------------------------------------------------------------------------
// Deteccion del tipo de documento
// ---------------------------------------------------------------------------

export function detectarTipo(texto: string): TipoDocumento {
  const cabeza = texto.slice(0, 400);
  if (/OTROS[IÍ]\s+No\./iu.test(cabeza)) {
    return "otrosi";
  }
  if (/CONTRATO\s+MARCO/iu.test(cabeza)) {
    return "contrato_marco";
  }
  if (/COTIZACI[OÓ]N\s+No\./iu.test(cabeza)) {
    return "cotizacion";
  }
  if (/CONTRATO\s+DE\s+/iu.test(cabeza)) {
    return "contrato";
  }
  return "desconocido";
}

// ---------------------------------------------------------------------------
// Extractores por campo
// ---------------------------------------------------------------------------

/** El id del contrato: CT-AAAA-NNN o CM-AAAA-NN. Una cotizacion trae COT-,
 *  que a proposito no casa. */
function extraerIdContrato(texto: string): Campo {
  const hallazgo = /\b((?:CT|CM)-\d{4}-\d{2,3})\b/u.exec(texto);
  if (hallazgo === null || hallazgo[1] === undefined) {
    return ausente("no hay identificador con patron CT-AAAA-NNN ni CM-AAAA-NN");
  }
  return literal(hallazgo[1]);
}

const CONECTORES: readonly string[] = ["de", "del", "y", "e"];

/**
 * El documento escribe la razon social en mayuscula sostenida; el maestro
 * la guarda en capitalizacion normal. Se conservan las siglas con puntos
 * (S.A.S., S.A.C.) y se bajan solo los conectores de/del/y/e.
 */
function capitalizarRazonSocial(bruto: string): string {
  return espacios(bruto)
    .split(" ")
    .map((palabra, indice) => {
      if (/^[A-ZÁÉÍÓÚÑ]\.(?:[A-ZÁÉÍÓÚÑ]\.)+$/u.test(palabra)) {
        return palabra;
      }
      const baja = palabra.toLocaleLowerCase("es");
      if (indice > 0 && CONECTORES.includes(baja)) {
        return baja;
      }
      return baja.charAt(0).toLocaleUpperCase("es") + baja.slice(1);
    })
    .join(" ");
}

/**
 * Las partes. El contratante es SIEMPRE el primero; el segundo firmante es
 * Periferia IT Group, que no es el cliente. Por eso se ancla en "Entre" y
 * no se busca el primer NIT del texto.
 */
interface Partes {
  cliente: string;
  clase: "NIT" | "RUC";
  identificador: string;
}

function extraerPartes(texto: string): Partes | null {
  const hallazgo =
    /Entre(?:\s+los\s+suscritos,)?\s+([^,\n]+?),\s*(?:identificada\s+con\s+)?(NIT|RUC)\s+([\d.\-]+)/iu.exec(
      texto,
    );
  if (
    hallazgo === null ||
    hallazgo[1] === undefined ||
    hallazgo[2] === undefined ||
    hallazgo[3] === undefined
  ) {
    return null;
  }
  return {
    cliente: hallazgo[1],
    clase: hallazgo[2].toUpperCase() === "RUC" ? "RUC" : "NIT",
    identificador: hallazgo[3],
  };
}

/** Quita puntos y el digito de verificacion: 890.900.111-4 -> 890900111. */
function normalizarIdentificador(bruto: string): string {
  const sinPuntos = bruto.replace(/\./gu, "");
  const guion = sinPuntos.indexOf("-");
  return guion === -1 ? sinPuntos : sinPuntos.slice(0, guion);
}

const CIUDADES: Readonly<Record<string, string>> = {
  bogot: "CO",
  medell: "CO",
  barranquilla: "CO",
  cali: "CO",
  quito: "EC",
  guayaquil: "EC",
  lima: "PE",
  arequipa: "PE",
  tegucigalpa: "HN",
  panam: "PA",
};

/**
 * El pais sale del formato del identificador tributario. Es una regla
 * cerrada con respuesta unica, por eso 0.9 y no 0.6.
 *
 * Si el formato no alcanza, se cae a la mencion textual de pais o ciudad,
 * pero SOLO en el tramo anterior a "PERIFERIA IT GROUP": todos los
 * contratos dicen "Medellin, Colombia" al presentar al contratista, y ese
 * tramo contaminaria la inferencia.
 */
function extraerPais(texto: string, partes: Partes | null): Campo {
  if (partes !== null) {
    const digitos = normalizarIdentificador(partes.identificador);
    if (partes.clase === "NIT" && digitos.length === 9) {
      return deducido("CO", "NIT colombiano de 9 digitos mas verificador");
    }
    if (
      partes.clase === "RUC" &&
      digitos.length === 13 &&
      digitos.endsWith("001")
    ) {
      return deducido("EC", "RUC ecuatoriano de 13 digitos terminado en 001");
    }
    if (partes.clase === "RUC" && /^(?:10|15|17|20)\d{9}$/u.test(digitos)) {
      return deducido("PE", "RUC peruano de 11 digitos");
    }
    if (digitos.length === 14 && digitos.startsWith("08")) {
      return deducido("HN", "RTN hondureno de 14 digitos");
    }
  }

  const corte = texto.search(/PERIFERIA\s+IT\s+GROUP/iu);
  const tramo = (corte === -1 ? texto : texto.slice(0, corte)).toLowerCase();
  for (const [aguja, iso] of Object.entries(CIUDADES)) {
    if (tramo.includes(aguja)) {
      return deducido(iso, `mencion de "${aguja}" en el tramo del contratante`);
    }
  }
  return ausente("el identificador tributario no casa con ningun formato conocido y el texto no menciona pais ni ciudad del contratante");
}

function extraerObjeto(texto: string): Campo {
  const cuerpo = clausula(texto, "OBJETO");
  if (cuerpo === null || cuerpo === "") {
    return ausente("no hay clausula rotulada OBJETO");
  }
  return normalizado(
    cuerpo,
    "texto literal de la clausula OBJETO, sin resumir: resumirlo seria paráfrasis y aqui no participa el modelo",
  );
}

/**
 * Convierte "265.000.000", "120,000.00" y "520,000.00" al entero del
 * maestro. La convencion no se asume por moneda sino por la forma del
 * numero: el ultimo separador con menos de tres digitos detras es el
 * decimal.
 */
function aNumero(bruto: string): number | null {
  const limpio = bruto.trim();
  if (!/^[\d.,]+$/u.test(limpio)) {
    return null;
  }
  const ultimoPunto = limpio.lastIndexOf(".");
  const ultimaComa = limpio.lastIndexOf(",");
  const corte = Math.max(ultimoPunto, ultimaComa);
  let entero = limpio;
  let decimales = "";
  if (corte !== -1 && limpio.length - corte - 1 < 3) {
    entero = limpio.slice(0, corte);
    decimales = limpio.slice(corte + 1);
  }
  const digitos = entero.replace(/[.,]/gu, "");
  if (digitos === "") {
    return null;
  }
  const numero = Number(`${digitos}.${decimales === "" ? "0" : decimales}`);
  return Number.isFinite(numero) ? Math.round(numero) : null;
}

interface ValorLeido {
  valor: Campo;
  moneda: Campo;
  indeterminado: boolean;
}

function extraerValor(texto: string, tipo: TipoDocumento): ValorLeido {
  const cuerpo = segmento(texto, tipo, "VALOR");
  if (cuerpo === null) {
    return {
      valor: ausente("no hay clausula de VALOR"),
      moneda: ausente("no hay clausula de VALOR de la que leer la moneda"),
      indeterminado: false,
    };
  }

  // Contrato por demanda: el texto declara que no hay valor determinado.
  if (/no\s+tiene\s+un\s+valor\s+determinado/iu.test(cuerpo)) {
    return {
      valor: parcial(
        0,
        "contrato por demanda: la clausula declara que no hay valor determinado y remite a ordenes de servicio",
      ),
      // No se hereda la moneda del umbral de garantias ni del pais: seria
      // inferir a un valor plausible.
      moneda: ausente(
        "el contrato no fija un valor, asi que no declara moneda para el",
      ),
      indeterminado: true,
    };
  }

  const hallazgo = /\b(COP|USD|PEN|EUR|MXN|CLP)\b\s*\$?\s*([\d.,]+)/u.exec(
    cuerpo,
  );
  if (
    hallazgo === null ||
    hallazgo[1] === undefined ||
    hallazgo[2] === undefined
  ) {
    return {
      valor: ausente("la clausula de VALOR no trae un monto con codigo ISO"),
      moneda: ausente("la clausula de VALOR no trae codigo ISO de moneda"),
      indeterminado: false,
    };
  }

  const numero = aNumero(hallazgo[2]);
  if (numero === null) {
    return {
      valor: ausente(`monto ilegible: "${hallazgo[2]}"`),
      moneda: literal(hallazgo[1]),
      indeterminado: false,
    };
  }

  return {
    valor: normalizado(
      numero,
      "monto de la clausula VALOR, separadores de miles retirados",
    ),
    moneda: literal(hallazgo[1]),
    indeterminado: false,
  };
}

interface Plazo {
  inicio: Campo;
  fin: Campo;
}

const FECHA_LARGA = String.raw`\((\d{1,2})\)\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})`;

function extraerPlazo(texto: string, tipo: TipoDocumento): Plazo {
  const cuerpo = segmento(texto, tipo, "PLAZO");
  if (cuerpo === null) {
    return {
      inicio: ausente("no hay clausula de PLAZO"),
      fin: ausente("no hay clausula de PLAZO"),
    };
  }

  const desde = new RegExp(String.raw`desde\s+el\s+.*?${FECHA_LARGA}`, "iu").exec(
    cuerpo,
  );
  const hasta = new RegExp(String.raw`hasta\s+el\s+.*?${FECHA_LARGA}`, "iu").exec(
    cuerpo,
  );

  const isoInicio =
    desde !== null &&
    desde[1] !== undefined &&
    desde[2] !== undefined &&
    desde[3] !== undefined
      ? aIso(desde[1], desde[2], desde[3])
      : null;
  const isoFin =
    hasta !== null &&
    hasta[1] !== undefined &&
    hasta[2] !== undefined &&
    hasta[3] !== undefined
      ? aIso(hasta[1], hasta[2], hasta[3])
      : null;

  const inicio =
    isoInicio === null
      ? fechaInicioSinClausula(texto, cuerpo)
      : normalizado(isoInicio, "fecha literal de la clausula PLAZO");

  if (isoFin !== null) {
    // La fecha literal gana sobre el plazo en meses aunque el texto traiga
    // ambos: solo se deriva cuando no hay fecha escrita.
    return {
      inicio,
      fin: normalizado(isoFin, "fecha literal de la clausula PLAZO"),
    };
  }

  const meses = mesesDePlazo(cuerpo);
  if (meses !== null && typeof inicio.valor === "string") {
    return {
      inicio,
      fin: derivado(
        sumarMeses(inicio.valor, meses),
        `derivada: no hay fecha de terminacion escrita; se sumaron ${meses} meses a fecha_inicio (${inicio.valor})`,
      ),
    };
  }

  if (meses !== null) {
    return {
      inicio,
      fin: parcial(
        null,
        `el plazo es de ${meses} meses pero no hay fecha de inicio determinable, asi que no hay base para derivar la terminacion`,
      ),
    };
  }

  return {
    inicio,
    fin: ausente("la clausula PLAZO no trae fecha de terminacion ni duracion en meses"),
  };
}

const NUMEROS_ESCRITOS: Readonly<Record<string, number>> = {
  tres: 3,
  seis: 6,
  nueve: 9,
  doce: 12,
  dieciocho: 18,
  veinticuatro: 24,
  treinta: 30,
  treintaiseis: 36,
};

function mesesDePlazo(cuerpo: string): number | null {
  const conDigito = /\((\d{1,3})\)\s*meses/iu.exec(cuerpo);
  if (conDigito !== null && conDigito[1] !== undefined) {
    return Number(conDigito[1]);
  }
  const conLetra = /\b([a-záéíóú]+)\s+meses\b/iu.exec(cuerpo);
  if (conLetra !== null && conLetra[1] !== undefined) {
    const valor = NUMEROS_ESCRITOS[conLetra[1].toLowerCase()];
    if (valor !== undefined) {
      return valor;
    }
  }
  return null;
}

/**
 * El plazo puede contarse "a partir de la fecha de su firma". Si la firma
 * no trae dia, no hay fecha de inicio: no se asume el dia 1 ni se toma la
 * fecha del correo. Queda en parcial, que es lo que un humano debe mirar.
 */
function fechaInicioSinClausula(texto: string, cuerpo: string): Campo {
  if (!/a\s+partir\s+de\s+la\s+fecha\s+de\s+su\s+firma/iu.test(cuerpo)) {
    return ausente("la clausula PLAZO no trae fecha de inicio");
  }
  const completa = new RegExp(
    String.raw`[Ss]e\s+firma[^.]*?a\s+los\s+${FECHA_LARGA}`,
    "iu",
  ).exec(texto);
  if (
    completa !== null &&
    completa[1] !== undefined &&
    completa[2] !== undefined &&
    completa[3] !== undefined
  ) {
    const iso = aIso(completa[1], completa[2], completa[3]);
    if (iso !== null) {
      return normalizado(
        iso,
        "el plazo corre desde la firma y la firma trae fecha completa",
      );
    }
  }
  const soloMes = /[Ss]e\s+firma[^.]*?en\s+el\s+mes\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/iu.exec(
    texto,
  );
  if (soloMes !== null && soloMes[1] !== undefined && soloMes[2] !== undefined) {
    return parcial(
      null,
      `el plazo corre desde la firma y la firma dice "mes de ${soloMes[1]} de ${soloMes[2]}" sin dia; no se asume el dia 1 ni se toma la fecha del correo`,
    );
  }
  return ausente("el plazo corre desde la firma y la firma no trae fecha");
}

const TIPOS_POLIZA: readonly (readonly [RegExp, string])[] = [
  [/cumplimiento/iu, "cumplimiento"],
  [/calidad/iu, "calidad"],
  [/salarios|prestaciones/iu, "salarios_prestaciones"],
  [/responsabilidad\s+civil/iu, "responsabilidad_civil"],
];

interface Garantias {
  requiere: Campo;
  tipo: Campo;
}

/**
 * Un contrato marco condiciona la poliza a ordenes de servicio futuras.
 * Eso es "presente pero el texto no lo fija": 0.3, y el valor se deja en
 * true, no en false. Marcarlo false apagaria la alerta, y el proyecto
 * existe justamente porque hay polizas exigidas que nadie constituye.
 */
function extraerGarantias(texto: string, tipo: TipoDocumento): Garantias {
  const cuerpo = cuerpoGarantias(texto, tipo);

  if (cuerpo === null) {
    return {
      requiere: deducido(
        false,
        "el documento no tiene clausula de garantias ni menciona poliza; en un contrato de clausulas ordinales exhaustivas la ausencia es informacion",
      ),
      tipo: deducido(
        null,
        "no aplica: el contrato no exige poliza",
      ),
    };
  }

  const clases = TIPOS_POLIZA.filter(([patron]) => patron.test(cuerpo)).map(
    ([, nombre]) => nombre,
  );
  const listado = clases.length === 0 ? null : clases.join(";");

  const condicionada =
    /para\s+cada|cuyo\s+valor\s+supere|orden(?:es)?\s+de\s+servicio|siempre\s+que/iu.test(
      cuerpo,
    );

  if (condicionada) {
    const explicacion =
      "la clausula de garantias existe pero condiciona la poliza a ordenes de servicio futuras, no al contrato que se firma hoy; un humano debe leerla";
    return {
      requiere: parcial(true, explicacion),
      tipo: parcial(listado, explicacion),
    };
  }

  return {
    requiere: normalizado(true, "clausula de garantias que constituye poliza"),
    tipo:
      listado === null
        ? ausente("la clausula de garantias no nombra el tipo de poliza")
        : normalizado(listado, "tipos nombrados en la clausula de garantias"),
  };
}

function cuerpoGarantias(texto: string, tipo: TipoDocumento): string | null {
  if (tipo === "otrosi") {
    // El otrosi no rotula garantias: las menciona al decir que las demas
    // clausulas permanecen.
    const frase = /[^.]*\b(?:garant[ií]as|p[oó]liza)\b[^.]*\./iu.exec(texto);
    return frase === null ? null : espacios(frase[0]);
  }
  const rotulada = clausula(texto, "GARANT[IÍ]AS");
  if (rotulada !== null && rotulada !== "") {
    return rotulada;
  }
  const suelta = /[^.]*\bp[oó]liza\b[^.]*\./iu.exec(texto);
  return suelta === null ? null : espacios(suelta[0]);
}

// ---------------------------------------------------------------------------
// Lectura del buzon (solo lectura)
// ---------------------------------------------------------------------------

interface Correo {
  id: string;
  de: string;
  asunto: string;
  fecha: string;
  adjuntos: readonly string[];
}

const esquemaCorreo = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  adjuntos: z.array(z.string()),
});

function leerCorreo(carpeta: string): Correo | null {
  const ruta = join(RAIZ_BUZON, carpeta, "correo.json");
  if (!existsSync(ruta)) {
    return null;
  }
  let crudo: unknown;
  try {
    crudo = JSON.parse(readFileSync(ruta, "utf8"));
  } catch {
    return null;
  }
  const analizado = esquemaCorreo.safeParse(crudo);
  return analizado.success ? analizado.data : null;
}

/** Una entrada del registro de mensajes ya procesados. */
export interface MensajeProcesado {
  mensaje_id: string;
  id_contrato: string | null;
  accion: string;
  ts: string;
}

interface ProcesadosEnDisco {
  entradas: readonly MensajeProcesado[];
  /** false = el archivo existe pero no se pudo interpretar. */
  legible: boolean;
}

/** Normaliza cualquiera de las formas aceptadas a la entrada canonica. */
function normalizarProcesado(entrada: unknown): MensajeProcesado | null {
  if (typeof entrada === "string") {
    return { mensaje_id: entrada, id_contrato: null, accion: "", ts: "" };
  }
  if (typeof entrada !== "object" || entrada === null) {
    return null;
  }
  const fila = entrada as Record<string, unknown>;
  const id = fila["mensaje_id"] ?? fila["id"];
  if (typeof id !== "string") {
    return null;
  }
  return {
    mensaje_id: id,
    id_contrato:
      typeof fila["id_contrato"] === "string" ? fila["id_contrato"] : null,
    accion: typeof fila["accion"] === "string" ? fila["accion"] : "",
    ts: typeof fila["ts"] === "string" ? fila["ts"] : "",
  };
}

/**
 * UN SOLO lector de out/procesados.json, para el que lee y para el que
 * escribe.
 *
 * Antes habia dos parsers distintos y no aceptaban lo mismo: el lector
 * admitia tambien la forma {"procesados": [...]}, y el escritor, al ver
 * que la raiz no era un array, la descartaba y reescribia el archivo desde
 * cero. Resultado: todo el historial de procesados desaparecia en
 * silencio y los mensajes ya registrados volvian a aparecer como nuevos.
 *
 * Con un solo parser el desacuerdo no puede volver a existir.
 */
export function leerProcesadosDeDisco(): ProcesadosEnDisco {
  if (!existsSync(RUTA_PROCESADOS)) {
    return { entradas: [], legible: true };
  }
  let crudo: unknown;
  try {
    crudo = JSON.parse(readFileSync(RUTA_PROCESADOS, "utf8"));
  } catch {
    return { entradas: [], legible: false };
  }
  const lista = Array.isArray(crudo)
    ? crudo
    : typeof crudo === "object" &&
        crudo !== null &&
        Array.isArray((crudo as { procesados?: unknown }).procesados)
      ? (crudo as { procesados: unknown[] }).procesados
      : null;
  if (lista === null) {
    return { entradas: [], legible: false };
  }
  const entradas: MensajeProcesado[] = [];
  for (const entrada of lista) {
    const normalizada = normalizarProcesado(entrada);
    if (normalizada !== null) {
      entradas.push(normalizada);
    }
  }
  return { entradas, legible: true };
}

/** Ids ya procesados. Que el archivo no exista no es un error:
 *  significa que no se ha procesado nada todavia. */
function leerProcesados(): ReadonlySet<string> {
  return new Set(
    leerProcesadosDeDisco().entradas.map((entrada) => entrada.mensaje_id),
  );
}

function carpetasDelBuzon(): readonly string[] {
  if (!existsSync(RAIZ_BUZON)) {
    return [];
  }
  return readdirSync(RAIZ_BUZON, { withFileTypes: true })
    .filter((entrada) => entrada.isDirectory())
    .map((entrada) => entrada.name)
    .sort();
}

function leerAdjunto(carpeta: string, nombre: string): string | null {
  const ruta = join(RAIZ_BUZON, carpeta, nombre);
  if (!existsSync(ruta)) {
    return null;
  }
  return readFileSync(ruta, "utf8");
}

/**
 * Si el mensaje trae materia contractual. Se decide por CONTENIDO del
 * adjunto, no por su nombre: "contrato.txt" y "otrosi.txt" cuentan,
 * "cotizacion.txt" no, y un archivo mal nombrado no enganaria a ninguno
 * de los dos lados.
 */
function tieneContrato(carpeta: string, adjuntos: readonly string[]): boolean {
  return adjuntos.some((nombre) => {
    const texto = leerAdjunto(carpeta, nombre);
    return texto !== null && TIPOS_CONTRACTUALES.includes(detectarTipo(texto));
  });
}

export interface MensajePendiente {
  id: string;
  de: string;
  asunto: string;
  fecha: string;
  adjuntos: readonly string[];
  tiene_contrato: boolean;
}

export function listarPendientes(): readonly MensajePendiente[] {
  const procesados = leerProcesados();
  const pendientes: MensajePendiente[] = [];
  for (const carpeta of carpetasDelBuzon()) {
    const correo = leerCorreo(carpeta);
    if (correo === null || procesados.has(correo.id)) {
      continue;
    }
    pendientes.push({
      id: correo.id,
      de: correo.de,
      asunto: correo.asunto,
      fecha: correo.fecha,
      adjuntos: correo.adjuntos,
      tiene_contrato: tieneContrato(carpeta, correo.adjuntos),
    });
  }
  return pendientes;
}

// ---------------------------------------------------------------------------
// Extraccion
// ---------------------------------------------------------------------------

export interface Extraccion {
  mensaje_id: string;
  adjunto: string | null;
  tipo_documento: TipoDocumento;
  extraible: boolean;
  valor_indeterminado: boolean;
  campos: Readonly<Record<NombreCampo, Campo>>;
  requiere_revision: readonly NombreCampo[];
  corte_revision: number;
  motivo: string | null;
}

/**
 * RN5. Un campo no_aplica NO entra: no es baja confianza, es que este tipo
 * de documento no lo trae. Un campo ausente SI entra.
 */
export function camposEnRevision(
  campos: Readonly<Record<NombreCampo, Campo>>,
): readonly NombreCampo[] {
  return NOMBRES_CAMPO.filter((nombre) => {
    const campo = campos[nombre];
    return campo.estado !== "no_aplica" && campo.confianza < CORTE_REVISION;
  });
}

function camposVacios(nota: string): Record<NombreCampo, Campo> {
  const campos: Partial<Record<NombreCampo, Campo>> = {};
  for (const nombre of NOMBRES_CAMPO) {
    campos[nombre] = ausente(nota);
  }
  return campos as Record<NombreCampo, Campo>;
}

function aplicarNoAplica(
  campos: Record<NombreCampo, Campo>,
  tipo: TipoDocumento,
): Record<NombreCampo, Campo> {
  for (const nombre of CAMPOS_NO_APLICA[tipo]) {
    campos[nombre] = noAplica(
      `un documento de tipo "${tipo}" no trae este campo; lo conserva el contrato original`,
    );
  }
  return campos;
}

export function extraerDeTexto(
  mensajeId: string,
  adjunto: string | null,
  texto: string,
): Extraccion {
  const tipo = detectarTipo(texto);

  if (!TIPOS_CONTRACTUALES.includes(tipo)) {
    const motivo = `el adjunto es de tipo "${tipo}", no es materia contractual`;
    const campos = camposVacios(motivo);
    return {
      mensaje_id: mensajeId,
      adjunto,
      tipo_documento: tipo,
      extraible: false,
      valor_indeterminado: false,
      campos,
      requiere_revision: camposEnRevision(campos),
      corte_revision: CORTE_REVISION,
      motivo,
    };
  }

  const partes = extraerPartes(texto);
  const leidoValor = extraerValor(texto, tipo);
  const plazo = extraerPlazo(texto, tipo);
  const garantias = extraerGarantias(texto, tipo);

  const campos: Record<NombreCampo, Campo> = {
    id_contrato: extraerIdContrato(texto),
    cliente:
      partes === null
        ? ausente("no se identifico la clausula de partes")
        : normalizado(
            capitalizarRazonSocial(partes.cliente),
            "razon social del contratante, llevada a la capitalizacion del maestro",
          ),
    nit_cliente:
      partes === null
        ? ausente("no se identifico la clausula de partes")
        : normalizado(
            normalizarIdentificador(partes.identificador),
            `${partes.clase} del contratante, sin puntos ni digito de verificacion`,
          ),
    pais: extraerPais(texto, partes),
    objeto: extraerObjeto(texto),
    valor: leidoValor.valor,
    moneda: leidoValor.moneda,
    fecha_inicio: plazo.inicio,
    fecha_fin: plazo.fin,
    requiere_poliza: garantias.requiere,
    tipo_poliza: garantias.tipo,
  };

  const finales = aplicarNoAplica(campos, tipo);

  return {
    mensaje_id: mensajeId,
    adjunto,
    tipo_documento: tipo,
    extraible: true,
    valor_indeterminado: leidoValor.indeterminado,
    campos: finales,
    requiere_revision: camposEnRevision(finales),
    corte_revision: CORTE_REVISION,
    motivo: null,
  };
}

/** Localiza el mensaje y su adjunto de texto. Devuelve el motivo si falla. */
function abrirMensaje(
  mensajeId: string,
): { adjunto: string; texto: string } | string {
  const carpeta = carpetasDelBuzon().find((nombre) => {
    const correo = leerCorreo(nombre);
    return correo !== null && correo.id === mensajeId;
  });
  if (carpeta === undefined) {
    return `no existe el mensaje "${mensajeId}" en ${RAIZ_BUZON}`;
  }
  const correo = leerCorreo(carpeta);
  if (correo === null) {
    return `el mensaje "${mensajeId}" no tiene un correo.json legible`;
  }
  for (const nombre of correo.adjuntos) {
    const texto = leerAdjunto(carpeta, nombre);
    if (texto !== null) {
      return { adjunto: nombre, texto };
    }
  }
  return `el mensaje "${mensajeId}" no tiene adjuntos legibles`;
}

export function extraerDeMensaje(mensajeId: string): Extraccion | string {
  const abierto = abrirMensaje(mensajeId);
  if (typeof abierto === "string") {
    return abierto;
  }
  return extraerDeTexto(mensajeId, abierto.adjunto, abierto.texto);
}

// ---------------------------------------------------------------------------
// Maestro de contratos (solo lectura)
// ---------------------------------------------------------------------------

/** Parser CSV minimo con comillas. El fixture no las usa, pero un maestro
 *  real que traiga una coma dentro de un objeto no debe partir la fila. */
function parsearCsv(texto: string): readonly (readonly string[])[] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = "";
  let entreComillas = false;
  for (let indice = 0; indice < texto.length; indice += 1) {
    const caracter = texto.charAt(indice);
    if (entreComillas) {
      if (caracter === '"') {
        if (texto.charAt(indice + 1) === '"') {
          celda += '"';
          indice += 1;
        } else {
          entreComillas = false;
        }
      } else {
        celda += caracter;
      }
      continue;
    }
    if (caracter === '"') {
      entreComillas = true;
      continue;
    }
    if (caracter === ",") {
      fila.push(celda);
      celda = "";
      continue;
    }
    if (caracter === "\n") {
      fila.push(celda);
      filas.push(fila);
      fila = [];
      celda = "";
      continue;
    }
    if (caracter === "\r") {
      continue;
    }
    celda += caracter;
  }
  if (celda !== "" || fila.length > 0) {
    fila.push(celda);
    filas.push(fila);
  }
  return filas.filter((linea) => linea.some((valor) => valor.trim() !== ""));
}

export type FilaMaestro = Readonly<Record<string, string>>;

export interface Maestro {
  /** Ruta de la que se leyo: sharepoint si existe, fixture si no. */
  fuente: string;
  filas: readonly FilaMaestro[];
}

export function leerMaestro(): Maestro {
  const fuente = existsSync(RUTA_MAESTRO_SHAREPOINT)
    ? RUTA_MAESTRO_SHAREPOINT
    : RUTA_MAESTRO_FIXTURE;
  if (!existsSync(fuente)) {
    return { fuente, filas: [] };
  }
  const tabla = parsearCsv(readFileSync(fuente, "utf8"));
  const encabezado = tabla[0];
  if (encabezado === undefined) {
    return { fuente, filas: [] };
  }
  const filas = tabla.slice(1).map((linea) => {
    const fila: Record<string, string> = {};
    encabezado.forEach((columna, indice) => {
      fila[columna] = linea[indice] ?? "";
    });
    return fila;
  });
  return { fuente, filas };
}

// ---------------------------------------------------------------------------
// Similitud de objeto (segunda llave de RN2)
// ---------------------------------------------------------------------------

/** Umbral que fija el PRD para la segunda llave de RN2. */
export const UMBRAL_SIMILITUD = 0.9;

/** Minusculas, sin tildes, sin puntuacion, espacios colapsados. Esto solo
 *  hace que la metrica este bien definida; NO intenta cerrar la brecha
 *  entre el texto literal del contrato y el resumen del maestro. */
function normalizarParaComparar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-z0-9ñ]+/gu, " ")
    .trim();
}

/**
 * Coeficiente de Dice sobre bigramas de caracteres. Determinista, sin
 * dependencias, insensible al reordenamiento de palabras.
 *
 * Medido sobre el unico par real de los fixtures (msg-004 contra
 * CT-2026-012) da 0.352 frente a un umbral de 0.9: el objeto literal del
 * contrato y el objeto resumido del maestro no se parecen lo suficiente.
 * Ver S-4 y S-9 en SUPUESTOS.md.
 */
export function similitud(a: string, b: string): number {
  const izquierda = normalizarParaComparar(a);
  const derecha = normalizarParaComparar(b);
  if (izquierda === "" || derecha === "") {
    return 0;
  }
  if (izquierda === derecha) {
    return 1;
  }
  const bigramas = (texto: string): string[] => {
    const salida: string[] = [];
    for (let indice = 0; indice < texto.length - 1; indice += 1) {
      salida.push(texto.slice(indice, indice + 2));
    }
    return salida;
  };
  const primeros = bigramas(izquierda);
  const restantes = bigramas(derecha);
  if (primeros.length === 0 || restantes.length === 0) {
    return 0;
  }
  const disponibles = [...restantes];
  let comunes = 0;
  for (const par of primeros) {
    const posicion = disponibles.indexOf(par);
    if (posicion !== -1) {
      comunes += 1;
      disponibles.splice(posicion, 1);
    }
  }
  return (2 * comunes) / (primeros.length + restantes.length);
}

// ---------------------------------------------------------------------------
// Validacion y clasificacion (RN1 a RN4)
// ---------------------------------------------------------------------------

/** Nombre del contrato declarado en 6.2 del PRD. */
export type Clasificacion =
  | "nuevo"
  | "actualizacion"
  | "duplicado"
  | "rechazado";

/**
 * Campos que NO deberian cambiar nunca para un mismo id_contrato. Si
 * difieren frente al maestro es un conflicto: o la extraccion se
 * equivoco, o la fila del maestro esta mal. Entra en requiere_revision
 * aunque el campo venga con confianza alta.
 */
const CAMPOS_IDENTIDAD: readonly NombreCampo[] = [
  "cliente",
  "nit_cliente",
  "pais",
  "moneda",
];

/**
 * Campos que un otrosi o una correccion SI puede cambiar. Sus diferencias
 * son cambios, no conflictos: se reportan aparte y no bloquean.
 *
 * objeto queda fuera de ambas listas a proposito: el contrato lo trae
 * literal y el maestro resumido, asi que difieren siempre y compararlos
 * generaria un conflicto falso en cada duplicado. Ver S-4.
 */
const CAMPOS_MODIFICABLES: readonly NombreCampo[] = [
  "valor",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
];

/** Claves con las que RN1 decide que un contrato es el mismo sin cambios. */
const CLAVES_DUPLICADO: readonly NombreCampo[] = [
  "valor",
  "fecha_inicio",
  "fecha_fin",
];

/**
 * Una diferencia frente al maestro. El PRD (6.2) declara una sola clave
 * `diferencias`, asi que van todas juntas, pero conservan el
 * discriminador: un CAMBIO es lo que un otrosi viene a hacer y no bloquea;
 * un CONFLICTO es un campo de identidad que no deberia haber cambiado y si
 * bloquea. Fusionarlas sin `tipo` perderia S-10.
 */
export type TipoDiferencia = "cambio" | "conflicto";

export interface Diferencia {
  campo: NombreCampo;
  maestro: string;
  extraido: string | null;
  tipo: TipoDiferencia;
}

/** Vistas de `diferencias` por tipo, para quien necesite una sola clase. */
export function soloCambios(
  diferencias: readonly Diferencia[],
): readonly Diferencia[] {
  return diferencias.filter((una) => una.tipo === "cambio");
}

export function soloConflictos(
  diferencias: readonly Diferencia[],
): readonly Diferencia[] {
  return diferencias.filter((una) => una.tipo === "conflicto");
}

export interface Comercial {
  email: string;
  nombre: string | null;
  region: string | null;
  conocido: boolean;
}

export interface Coincidencia {
  id_contrato: string;
  llave: "id_contrato" | "nit_y_objeto";
  similitud_objeto: number | null;
}

export interface Validacion {
  mensaje_id: string;
  /** Nombre del contrato declarado en 6.2 del PRD. */
  clasificacion: Clasificacion;
  regla: "RN1" | "RN2" | "RN3" | "RN4";
  motivo: string | null;
  id_contrato: string | null;
  /** 6.2: el id de la fila del maestro con la que coincidio, si la hubo. */
  id_contrato_existente: string | null;
  tipo_documento: TipoDocumento;
  coincidencia: Coincidencia | null;
  /** 6.2: cambios y conflictos juntos, distinguidos por `tipo`. */
  diferencias: readonly Diferencia[];
  requiere_revision: readonly string[];
  /** Los mismos campos, sin la explicacion. Es el conjunto que
   *  `correcciones` puede pisar, y lo calcula el validador determinista. */
  campos_en_revision: readonly NombreCampo[];
  /**
   * Prueba de que este mensaje paso por aqui. contratos_registrar lo
   * exige y lo recalcula: el modelo no puede fabricarlo sin haber
   * llamado a esta herramienta. Ver comprobanteDe().
   */
  comprobante: string;
  comercial: Comercial;
  avisos: readonly string[];
  fuente_maestro: string;
}

/**
 * Prueba de que la extraccion paso por el validador.
 *
 * Es un hash corto de lo que el validador vio: el mensaje, la
 * clasificacion
 * que dedujo, y el estado de los once campos y de la fila del maestro con
 * la que comparo. contratos_registrar lo exige y lo recalcula por su
 * cuenta.
 *
 * Hace dos cosas, y la segunda no la habiamos cubierto:
 *
 * 1. El modelo no puede saltarse contratos_validar. No puede fabricar
 *    este valor sin haber llamado a la herramienta, asi que el flujo deja
 *    de ser una recomendacion del prompt y pasa a ser una precondicion
 *    del codigo.
 * 2. Cierra una carrera. Si el maestro cambia entre validar y registrar
 *    —otro mensaje del mismo lote inserto la fila, por ejemplo— el
 *    clasificacion que se aprobo ya no es la que aplica. El hash deja de
 *    coincidir y la escritura se rechaza en vez de aplicarse sobre un
 *    estado que nadie valido.
 */
export function comprobanteDe(datos: Extraccion, juicio: Validacion): string {
  const canonico = JSON.stringify({
    mensaje_id: datos.mensaje_id,
    tipo: datos.tipo_documento,
    clasificacion: juicio.clasificacion,
    regla: juicio.regla,
    id_contrato: juicio.id_contrato,
    coincidencia: juicio.coincidencia,
    diferencias: juicio.diferencias,
    revision: juicio.campos_en_revision,
    campos: NOMBRES_CAMPO.map((nombre) => [
      nombre,
      datos.campos[nombre].valor,
      datos.campos[nombre].estado,
    ]),
  });
  return createHash("sha256").update(canonico).digest("hex").slice(0, 16);
}

/** Representacion del valor extraido con la convencion del CSV. */
function comoTexto(valor: ValorCampo | null): string | null {
  if (valor === null) {
    return null;
  }
  if (typeof valor === "boolean") {
    return valor ? "true" : "false";
  }
  return String(valor);
}

function comercialDe(email: string): Comercial {
  if (!existsSync(RUTA_COMERCIALES)) {
    return { email, nombre: null, region: null, conocido: false };
  }
  let crudo: unknown;
  try {
    crudo = JSON.parse(readFileSync(RUTA_COMERCIALES, "utf8"));
  } catch {
    return { email, nombre: null, region: null, conocido: false };
  }
  const esquema = z.array(
    z.object({ email: z.string(), nombre: z.string(), region: z.string() }),
  );
  const analizado = esquema.safeParse(crudo);
  if (!analizado.success) {
    return { email, nombre: null, region: null, conocido: false };
  }
  const hallado = analizado.data.find(
    (fila) => fila.email.toLowerCase() === email.toLowerCase(),
  );
  if (hallado === undefined) {
    return { email, nombre: null, region: null, conocido: false };
  }
  return {
    email: hallado.email,
    nombre: hallado.nombre,
    region: hallado.region,
    conocido: true,
  };
}

/** El remitente del mensaje, para resolver el comercial. */
function remitenteDe(mensajeId: string): string | null {
  for (const carpeta of carpetasDelBuzon()) {
    const correo = leerCorreo(carpeta);
    if (correo !== null && correo.id === mensajeId) {
      return correo.de;
    }
  }
  return null;
}

/**
 * Busca la fila del maestro. Primera llave: mismo id_contrato. Segunda:
 * mismo nit_cliente mas objeto con similitud >= 0.9.
 *
 * La segunda no dispara en ningun fixture: en los cinco documentos
 * contractuales la primera acierta, y en el otrosi el objeto es no_aplica,
 * asi que no hay texto que comparar. Queda implementada para produccion.
 */
function buscarCoincidencia(
  campos: Readonly<Record<NombreCampo, Campo>>,
  maestro: Maestro,
): { fila: FilaMaestro; coincidencia: Coincidencia } | null {
  const idContrato = comoTexto(campos.id_contrato.valor);
  if (idContrato !== null) {
    const porId = maestro.filas.find((fila) => fila.id_contrato === idContrato);
    if (porId !== undefined) {
      return {
        fila: porId,
        coincidencia: {
          id_contrato: idContrato,
          llave: "id_contrato",
          similitud_objeto: null,
        },
      };
    }
  }

  const nit = comoTexto(campos.nit_cliente.valor);
  const objeto = campos.objeto.valor;
  if (nit === null || typeof objeto !== "string") {
    return null;
  }
  let mejor: { fila: FilaMaestro; puntaje: number } | null = null;
  for (const fila of maestro.filas) {
    if (fila.nit_cliente !== nit) {
      continue;
    }
    const puntaje = similitud(objeto, fila.objeto ?? "");
    if (mejor === null || puntaje > mejor.puntaje) {
      mejor = { fila, puntaje };
    }
  }
  if (mejor === null || mejor.puntaje < UMBRAL_SIMILITUD) {
    return null;
  }
  return {
    fila: mejor.fila,
    coincidencia: {
      id_contrato: mejor.fila.id_contrato ?? "",
      llave: "nit_y_objeto",
      similitud_objeto: Number(mejor.puntaje.toFixed(3)),
    },
  };
}

function compararContra(
  campos: Readonly<Record<NombreCampo, Campo>>,
  fila: FilaMaestro,
  nombres: readonly NombreCampo[],
  tipo: TipoDiferencia,
): readonly Diferencia[] {
  const diferencias: Diferencia[] = [];
  for (const nombre of nombres) {
    const campo = campos[nombre];
    // Un campo que este tipo de documento no trae no se compara: el
    // maestro conserva lo que ya tenia.
    if (campo.estado === "no_aplica") {
      continue;
    }
    const extraido = comoTexto(campo.valor);
    const enMaestro = fila[nombre] ?? "";
    if (extraido === null) {
      continue;
    }
    if (extraido !== enMaestro) {
      diferencias.push({ campo: nombre, maestro: enMaestro, extraido, tipo });
    }
  }
  return diferencias;
}

/**
 * @param maestroInyectado Solo para verificacion: permite clasificar
 * contra un maestro construido en memoria, sin tocar el disco ni el
 * fixture. En produccion se omite y se lee con leerMaestro().
 */
export function validarExtraccion(
  datos: Extraccion,
  maestroInyectado?: Maestro,
): Validacion {
  const base = validarSinComprobante(datos, maestroInyectado);
  return { ...base, comprobante: comprobanteDe(datos, base) };
}

function validarSinComprobante(
  datos: Extraccion,
  maestroInyectado?: Maestro,
): Validacion {
  const maestro = maestroInyectado ?? leerMaestro();
  const email = remitenteDe(datos.mensaje_id);
  const comercial =
    email === null
      ? { email: "", nombre: null, region: null, conocido: false }
      : comercialDe(email);

  const avisos: string[] = [];
  if (email === null) {
    avisos.push(
      `no se pudo leer el remitente de "${datos.mensaje_id}": el comercial queda sin resolver`,
    );
  } else if (!comercial.conocido) {
    // Se reporta, no bloquea: la clasificacion no depende de quien envia.
    avisos.push(
      `remitente desconocido: "${email}" no esta en comerciales.json; se reporta y no bloquea la clasificacion`,
    );
  }

  const base = {
    mensaje_id: datos.mensaje_id,
    tipo_documento: datos.tipo_documento,
    comercial,
    avisos,
    fuente_maestro: maestro.fuente,
    // Lo rellena validarExtraccion, que es quien envuelve a esta.
    comprobante: "",
  };

  // RN4: sin adjunto de contrato, o sin partes ni objeto identificables.
  if (!datos.extraible) {
    return {
      ...base,
      clasificacion: "rechazado",
      regla: "RN4",
      motivo:
        datos.motivo ??
        "el adjunto no es un documento contractual identificable",
      id_contrato: null,
      id_contrato_existente: null,
      coincidencia: null,
      diferencias: [],
      requiere_revision: [],
      campos_en_revision: [],
    };
  }

  const sinPartes =
    datos.campos.cliente.valor === null && datos.campos.nit_cliente.valor === null;
  const sinObjeto =
    datos.campos.objeto.valor === null && datos.campos.objeto.estado !== "no_aplica";
  if (sinPartes && sinObjeto) {
    return {
      ...base,
      clasificacion: "rechazado",
      regla: "RN4",
      motivo:
        "el texto no contiene partes ni objeto identificables: no hay razon social, ni identificador tributario, ni clausula de objeto",
      id_contrato: comoTexto(datos.campos.id_contrato.valor),
      id_contrato_existente: null,
      coincidencia: null,
      diferencias: [],
      requiere_revision: [],
      campos_en_revision: [],
    };
  }

  const idContrato = comoTexto(datos.campos.id_contrato.valor);
  const hallazgo = buscarCoincidencia(datos.campos, maestro);

  const bajaConfianza = datos.requiere_revision.map(
    (nombre) =>
      `${nombre}: confianza ${datos.campos[nombre].confianza} < ${CORTE_REVISION}`,
  );

  // RN3: no hay coincidencia, se inserta.
  if (hallazgo === null) {
    return {
      ...base,
      clasificacion: "nuevo",
      regla: "RN3",
      motivo: null,
      id_contrato: idContrato,
      id_contrato_existente: null,
      coincidencia: null,
      diferencias: [],
      requiere_revision: bajaConfianza,
      campos_en_revision: datos.requiere_revision,
    };
  }

  const conflictos = compararContra(
    datos.campos,
    hallazgo.fila,
    CAMPOS_IDENTIDAD,
    "conflicto",
  );
  const cambios = compararContra(
    datos.campos,
    hallazgo.fila,
    CAMPOS_MODIFICABLES,
    "cambio",
  );
  const diferencias = [...conflictos, ...cambios];

  const requiereRevision = [
    ...bajaConfianza,
    ...conflictos.map(
      (diferencia) =>
        `${diferencia.campo}: conflicto con el maestro (extraido "${diferencia.extraido}", maestro "${diferencia.maestro}")`,
    ),
  ];
  const camposEnRevisionTotal: readonly NombreCampo[] = [
    ...datos.requiere_revision,
    ...conflictos
      .map((diferencia) => diferencia.campo)
      .filter((campo) => !datos.requiere_revision.includes(campo)),
  ];

  // RN1: mismo id_contrato y mismos valor, fecha_inicio y fecha_fin.
  const clavesIguales = CLAVES_DUPLICADO.every((nombre) => {
    const campo = datos.campos[nombre];
    if (campo.estado === "no_aplica") {
      return false;
    }
    return comoTexto(campo.valor) === (hallazgo.fila[nombre] ?? "");
  });

  if (
    hallazgo.coincidencia.llave === "id_contrato" &&
    clavesIguales &&
    datos.tipo_documento !== "otrosi"
  ) {
    return {
      ...base,
      clasificacion: "duplicado",
      regla: "RN1",
      motivo: `mismo id_contrato y mismos valor, fecha_inicio y fecha_fin que la fila ${hallazgo.coincidencia.id_contrato}: no se escribe nada`,
      id_contrato: idContrato,
      id_contrato_existente: hallazgo.coincidencia.id_contrato,
      coincidencia: hallazgo.coincidencia,
      diferencias,
      requiere_revision: requiereRevision,
      campos_en_revision: camposEnRevisionTotal,
    };
  }

  // RN2: coincide y algo difiere, o el documento es un otrosi.
  const porOtrosi = datos.tipo_documento === "otrosi";
  return {
    ...base,
    clasificacion: "actualizacion",
    regla: "RN2",
    motivo: porOtrosi
      ? `el documento es un otrosi del contrato ${hallazgo.coincidencia.id_contrato}`
      : `coincide con ${hallazgo.coincidencia.id_contrato} y difieren: ${cambios.map((cambio) => cambio.campo).join(", ")}`,
    id_contrato: idContrato,
    id_contrato_existente: hallazgo.coincidencia.id_contrato,
    coincidencia: hallazgo.coincidencia,
    diferencias,
    requiere_revision: requiereRevision,
    campos_en_revision: camposEnRevisionTotal,
  };
}

// ---------------------------------------------------------------------------
// Registro: la UNICA herramienta que escribe en disco
// ---------------------------------------------------------------------------

/**
 * RN6. La primera escritura copia el fixture a out/sharepoint/ y a partir
 * de ahi se trabaja siempre sobre la copia. El fixture no se toca jamas:
 * copyFileSync solo lo lee.
 */
function asegurarCopiaMaestro(): boolean {
  if (existsSync(RUTA_MAESTRO_SHAREPOINT)) {
    return false;
  }
  mkdirSync(RAIZ_SHAREPOINT, { recursive: true });
  copyFileSync(RUTA_MAESTRO_FIXTURE, RUTA_MAESTRO_SHAREPOINT);
  return true;
}

function celdaCsv(valor: string): string {
  return /[",\n\r]/u.test(valor) ? `"${valor.replace(/"/gu, '""')}"` : valor;
}

function escribirMaestro(filas: readonly FilaMaestro[]): void {
  const lineas = [COLUMNAS_MAESTRO.join(",")];
  for (const fila of filas) {
    lineas.push(
      COLUMNAS_MAESTRO.map((columna) => celdaCsv(fila[columna] ?? "")).join(","),
    );
  }
  writeFileSync(RUTA_MAESTRO_SHAREPOINT, `${lineas.join("\n")}\n`, "utf8");
}

/** Formas societarias que el maestro no mete en la ruta. */
/**
 * Convierte una razon social en un segmento de ruta seguro, como los que
 * el maestro ya usa: "Distribuidora Caribe S.A.S." -> "distribuidora-caribe".
 * Quita la forma societaria, las tildes y todo lo que no sea alfanumerico.
 */
const FORMA_SOCIETARIA =
  /\s+(?:S\.A\.S\.|S\.A\.C\.|S\.R\.L\.|S\.\s*de\s*R\.L\.|S\.A\.|Ltda\.?|S\.L\.)\s*$/iu;

function comoSegmentoDeRuta(texto: string): string {
  return texto
    .replace(FORMA_SOCIETARIA, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** De donde salio el anio bajo el que se archiva el contrato. */
export type OrigenAnio =
  | "fecha_inicio"
  | "clausula_firma"
  | "fecha_fin_menos_plazo"
  | "fecha_correo"
  | "sin_anio";

export interface Archivado {
  anio: string;
  origen: OrigenAnio;
  /** Frase lista para leer en el chat, sin abrir el historial. */
  explicacion: string;
}

function anioDeFirma(texto: string): string | null {
  const completa = /[Ss]e\s+firma[^.]*?de\s+(\d{4})/u.exec(texto);
  return completa === null ? null : (completa[1] ?? null);
}

/**
 * Cadena de precedencia para el anio de archivo. Se detiene en el primer
 * eslabon que resuelve y dice cual fue.
 *
 * La ruta es un LUGAR de archivo, no un dato: un archivo mal colocado se
 * mueve, una fecha_inicio inventada en el maestro se propaga en silencio a
 * las alertas de HU-5. Por eso aqui se acepta el anio escrito en la
 * clausula de firma, que no basta para rellenar la columna. Ver S-13.
 */
function resolverAnio(
  campos: Readonly<Record<NombreCampo, Campo>>,
  texto: string,
  tipo: TipoDocumento,
  fechaCorreo: string | null,
): Archivado {
  const inicio = campos.fecha_inicio.valor;
  if (typeof inicio === "string" && /^\d{4}-/u.test(inicio)) {
    const anio = inicio.slice(0, 4);
    return {
      anio,
      origen: "fecha_inicio",
      explicacion: `archivado bajo ${anio} por la fecha de inicio del contrato`,
    };
  }

  const firma = anioDeFirma(texto);
  if (firma !== null) {
    return {
      anio: firma,
      origen: "clausula_firma",
      explicacion: `archivado bajo ${firma} por la clausula de firma: el documento no trae el dia, pero si el anio`,
    };
  }

  const fin = campos.fecha_fin.valor;
  const cuerpoPlazo = segmento(texto, tipo, "PLAZO");
  const meses = cuerpoPlazo === null ? null : mesesDePlazo(cuerpoPlazo);
  if (typeof fin === "string" && /^\d{4}-/u.test(fin) && meses !== null) {
    const anio = sumarMeses(fin, -meses).slice(0, 4);
    return {
      anio,
      origen: "fecha_fin_menos_plazo",
      explicacion: `archivado bajo ${anio}: fecha de terminacion ${fin} menos el plazo de ${meses} meses`,
    };
  }

  if (fechaCorreo !== null && /^\d{4}-/u.test(fechaCorreo)) {
    const anio = fechaCorreo.slice(0, 4);
    return {
      anio,
      origen: "fecha_correo",
      explicacion: `archivado bajo ${anio} por la fecha del correo: el documento no permite fecharlo`,
    };
  }

  return {
    anio: "sin-anio",
    origen: "sin_anio",
    explicacion:
      "archivado bajo sin-anio: ni el contrato ni el correo permiten fechar el inicio; queda localizable y visible como pendiente",
  };
}

// ---------------------------------------------------------------------------
// Esquema normativo del maestro (PRD 7.2)
// ---------------------------------------------------------------------------

/** 7.2 fija un maximo para el objeto. Recortar no es una decision nuestra. */
const MAXIMO_OBJETO = 200;

const PAISES: readonly string[] = ["CO", "EC", "PE", "PA", "HN"];
const MONEDAS: readonly string[] = ["COP", "USD", "PEN", "PAB", "HNL"];
const ESTADOS_POLIZA: readonly string[] = [
  "vigente",
  "pendiente",
  "vencida",
  "no_aplica",
];
const FUENTES: readonly string[] = ["buzon", "manual", "migracion"];

/** Columnas que no pueden ir vacias: sin ellas la fila no identifica nada. */
const COLUMNAS_OBLIGATORIAS: readonly string[] = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "fecha_registro",
  "fuente",
];

function esFechaIso(valor: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(valor)) {
    return false;
  }
  const fecha = new Date(`${valor}T00:00:00Z`);
  return (
    !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === valor
  );
}

/**
 * Valida la fila contra el esquema 7.2 ANTES de escribirla.
 *
 * El criterio, y es una decision que conviene entender: se valida la FORMA
 * de lo que hay, no se exige que este todo.
 *
 * - Una celda con un valor MAL FORMADO rechaza la escritura. Una moneda
 *   "EUROS" o una fecha "31/08/2027" corrompen el maestro en silencio y
 *   rompen las alertas, que es justo lo que este proyecto existe para
 *   evitar.
 * - Una celda VACIA se permite, salvo en las columnas que identifican la
 *   fila. Vacio no es un dato mal formado: es la ausencia declarada de un
 *   dato, ya marcada en requiere_revision y aprobada por una persona.
 *
 * Por que no se rechaza lo vacio: el esquema declara `moneda` como
 * COP|USD|PEN|PAB|HNL y las fechas como YYYY-MM-DD, y un contrato marco
 * por demanda no tiene moneda ni dia de firma. Exigir el enum haria
 * IMPOSIBLE registrar msg-006, que 7.4 manda registrar tras confirmar y
 * que 11 da por registrado en la demo. Entre dos lecturas del PRD que se
 * contradicen, se respeta la que tiene un caso de prueba. Ver S-29.
 */
export interface ProblemaEsquema {
  columna: string;
  valor: string;
  motivo: string;
}

export function validarFilaContraEsquema(
  fila: FilaMaestro,
): readonly ProblemaEsquema[] {
  const problemas: ProblemaEsquema[] = [];
  const lee = (columna: string): string => fila[columna] ?? "";

  for (const columna of COLUMNAS_OBLIGATORIAS) {
    if (lee(columna).trim() === "") {
      problemas.push({
        columna,
        valor: "",
        motivo: "columna obligatoria vacia: la fila no identificaria nada",
      });
    }
  }

  const enumerado = (
    columna: string,
    permitidos: readonly string[],
  ): void => {
    const valor = lee(columna);
    if (valor !== "" && !permitidos.includes(valor)) {
      problemas.push({
        columna,
        valor,
        motivo: `fuera del conjunto permitido (${permitidos.join("|")})`,
      });
    }
  };
  enumerado("pais", PAISES);
  enumerado("moneda", MONEDAS);
  enumerado("estado_poliza", ESTADOS_POLIZA);
  enumerado("fuente", FUENTES);

  for (const columna of ["fecha_inicio", "fecha_fin", "fecha_registro"]) {
    const valor = lee(columna);
    if (valor !== "" && !esFechaIso(valor)) {
      problemas.push({
        columna,
        valor,
        motivo: "no es una fecha YYYY-MM-DD existente en el calendario",
      });
    }
  }

  const valor = lee("valor");
  if (valor !== "" && !/^\d+$/u.test(valor)) {
    problemas.push({
      columna: "valor",
      valor,
      motivo: "debe ser un entero sin separadores",
    });
  }

  const poliza = lee("requiere_poliza");
  if (poliza !== "" && poliza !== "true" && poliza !== "false") {
    problemas.push({
      columna: "requiere_poliza",
      valor: poliza,
      motivo: "debe ser true o false",
    });
  }

  const objeto = lee("objeto");
  if (objeto.length > MAXIMO_OBJETO) {
    problemas.push({
      columna: "objeto",
      valor: `${objeto.length} caracteres`,
      motivo: `supera el maximo de ${MAXIMO_OBJETO}: deberia haberse recortado antes`,
    });
  }

  return problemas;
}

/**
 * Recorta el objeto al maximo de 7.2, por palabra entera. El texto
 * completo no se pierde: viaja en la extraccion y en el historial.
 */
function recortarObjeto(texto: string): string {
  if (texto.length <= MAXIMO_OBJETO) {
    return texto;
  }
  const corte = texto.slice(0, MAXIMO_OBJETO - 1);
  const ultimoEspacio = corte.lastIndexOf(" ");
  const base = ultimoEspacio > MAXIMO_OBJETO - 40 ? corte.slice(0, ultimoEspacio) : corte;
  return `${base.replace(/[\s,;.]+$/u, "")}…`;
}

export interface ResultadoRegistro {
  mensaje_id: string;
  id_contrato: string | null;
  accion: "nuevo" | "actualizacion" | "rechazado" | "duplicado" | "ya_procesado";
  ruta_archivo: string | null;
  archivado: Archivado | null;
  comercial: string;
  comercial_resuelto: boolean;
  estado_poliza: string;
  cambios: readonly Diferencia[];
  /** Rutas que esta llamada escribio, en orden. Vacio = no escribio nada. */
  escrituras: readonly string[];
  aviso: string | null;
  /** Campos que aporto una persona, con el valor exacto que aporto. */
  correcciones: readonly CorreccionAplicada[];
  /** Correcciones que llegaron sin confirmado: true y se descartaron. */
  correcciones_ignoradas: readonly string[];
  /** Campos que seguian en revision y nadie corrigio. Se registra igual
   *  porque el humano confirmo, pero quedan nombrados. Ver S-21. */
  revision_sin_corregir: readonly NombreCampo[];
  /** De donde salio cada columna de la fila escrita. */
  procedencia: Readonly<Record<string, string>>;
  /** La misma informacion en una frase, para leerla en el chat. */
  resumen_procedencia: string;
}

/** Valores por defecto de los campos de trazabilidad, para los caminos
 *  que no escriben la fila. */
function sinFila(
  aplicadas: readonly CorreccionAplicada[],
  ignoradas: readonly string[],
): Pick<
  ResultadoRegistro,
  | "correcciones"
  | "correcciones_ignoradas"
  | "revision_sin_corregir"
  | "procedencia"
  | "resumen_procedencia"
> {
  return {
    correcciones: aplicadas,
    correcciones_ignoradas: ignoradas,
    revision_sin_corregir: [],
    procedencia: {},
    resumen_procedencia:
      ignoradas.length > 0
        ? `no se escribio ninguna fila; se ignoraron ${ignoradas.length} correcciones por falta de confirmacion: ${ignoradas.join(", ")}`
        : "no se escribio ninguna fila",
  };
}

function hoyIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Anade una entrada al registro de procesados CONSERVANDO lo que ya
 * hubiera, sea cual sea la forma en que estuviera escrito.
 *
 * Devuelve el texto del error si el archivo existe y no se puede
 * interpretar: en ese caso NO se sobrescribe. Reescribirlo desde cero
 * destruiria un historial que no entendemos, que es justo el fallo que
 * este codigo tenia.
 */
export function marcarProcesado(
  mensajeId: string,
  idContrato: string | null,
  accion: string,
  ts: string,
): string | null {
  const enDisco = leerProcesadosDeDisco();
  if (!enDisco.legible) {
    return `${RUTA_PROCESADOS} existe pero no se puede interpretar. No se sobrescribe para no destruir el historial de mensajes ya procesados. Revisa o retira ese archivo y reintenta. No se ha escrito nada.`;
  }
  const entradas: MensajeProcesado[] = [
    ...enDisco.entradas,
    { mensaje_id: mensajeId, id_contrato: idContrato, accion, ts },
  ];
  mkdirSync(dirname(RUTA_PROCESADOS), { recursive: true });
  writeFileSync(
    RUTA_PROCESADOS,
    `${JSON.stringify(entradas, null, 2)}
`,
    "utf8",
  );
  return null;
}

/**
 * estado_poliza. En un alta es pendiente si el contrato exige poliza y
 * no_aplica si no. En una actualizacion se conserva lo que el maestro
 * tenga, SALVO que cambien valor o fecha_fin en un contrato con poliza:
 * una poliza se expide por un monto y una vigencia concretos, asi que si
 * cualquiera de los dos cambia la poliza vigente ya no cubre el contrato
 * y dejarla en "vigente" apagaria la alerta de HU-5. Ver S-14.
 */
function resolverEstadoPoliza(
  requierePoliza: ValorCampo | null,
  esActualizacion: boolean,
  anterior: string,
  cambios: readonly Diferencia[],
): string {
  if (!esActualizacion) {
    if (requierePoliza === true) {
      return "pendiente";
    }
    if (requierePoliza === false) {
      return "no_aplica";
    }
    return "pendiente";
  }
  const tocaLaPoliza = cambios.some(
    (cambio) => cambio.campo === "valor" || cambio.campo === "fecha_fin",
  );
  if (requierePoliza === true && tocaLaPoliza) {
    return "pendiente";
  }
  return anterior;
}

// ---------------------------------------------------------------------------
// Correcciones humanas
// ---------------------------------------------------------------------------

/** Una fecha bien formada Y que existe en el calendario: 2027-02-31 casa
 *  con el patron y no es un dia. */
const esquemaFecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "la fecha debe ser YYYY-MM-DD")
  .refine((valor) => {
    const fecha = new Date(`${valor}T00:00:00Z`);
    return (
      !Number.isNaN(fecha.getTime()) &&
      fecha.toISOString().slice(0, 10) === valor
    );
  }, "la fecha no existe en el calendario");

/**
 * Esquema por campo para lo que una persona puede aportar. Un valor
 * corregido se valida igual que si viniera del documento: confirmar no
 * exime de tener la forma correcta.
 */
const ESQUEMA_POR_CAMPO: Readonly<Record<NombreCampo, z.ZodType>> = {
  id_contrato: z.string().regex(/^[A-Z]{2}-\d{4}-\d{2,3}$/u),
  cliente: z.string().min(2),
  nit_cliente: z.string().regex(/^\d{6,20}$/u),
  pais: z.string().regex(/^[A-Z]{2}$/u),
  objeto: z.string().min(3),
  valor: z.number().int().min(0),
  moneda: z.string().regex(/^[A-Z]{3}$/u),
  fecha_inicio: esquemaFecha,
  fecha_fin: esquemaFecha,
  requiere_poliza: z.boolean(),
  tipo_poliza: z.string().min(0),
};

export interface CorreccionAplicada {
  campo: NombreCampo;
  valor: ValorCampo;
}

function esNombreCampo(valor: string): valor is NombreCampo {
  return (NOMBRES_CAMPO as readonly string[]).includes(valor);
}

/**
 * Aplica las correcciones sobre la extraccion. Devuelve la extraccion
 * corregida o el texto del error.
 *
 * Las tres puertas, en orden: el campo existe, estaba en revision, y el
 * valor tiene la forma del esquema.
 */
function aplicarCorrecciones(
  datos: Extraccion,
  enRevision: readonly NombreCampo[],
  correcciones: Readonly<Record<string, ValorCampo>>,
): { datos: Extraccion; aplicadas: readonly CorreccionAplicada[] } | string {
  const campos: Record<NombreCampo, Campo> = { ...datos.campos };
  const aplicadas: CorreccionAplicada[] = [];

  for (const [nombre, valor] of Object.entries(correcciones)) {
    if (!esNombreCampo(nombre)) {
      return `"${nombre}" no es un campo del maestro. Campos validos: ${NOMBRES_CAMPO.join(", ")}. No se ha escrito nada.`;
    }
    if (!enRevision.includes(nombre)) {
      const leido = datos.campos[nombre];
      return `"${nombre}" no estaba en requiere_revision: la extraccion lo leyo del documento con confianza ${leido.confianza} (${leido.estado}) y vale ${JSON.stringify(leido.valor)}. Corregir un campo que el documento afirma no es una correccion, es una sobreescritura, y no se acepta. No se ha escrito nada.`;
    }
    const analizado = ESQUEMA_POR_CAMPO[nombre].safeParse(valor);
    if (!analizado.success) {
      const motivos = analizado.error.issues
        .map((incidencia) => incidencia.message)
        .join("; ");
      return `el valor ${JSON.stringify(valor)} no es valido para "${nombre}": ${motivos}. No se ha escrito nada.`;
    }
    campos[nombre] = confirmado(
      valor,
      `valor aportado por una persona en la confirmacion; el documento no lo determina`,
    );
    aplicadas.push({ campo: nombre, valor });
  }

  const corregidos: Extraccion = {
    ...datos,
    campos,
    requiere_revision: camposEnRevision(campos),
  };
  return { datos: corregidos, aplicadas };
}

export interface OpcionesRegistro {
  confirmado: boolean;
  /** Fecha de registro, para que la demo y las pruebas sean deterministas. */
  hoy?: string;
  /** Valores aportados por una persona. Ver el comentario de la
   *  herramienta para por que se acepta que los componga el modelo. */
  correcciones?: Readonly<Record<string, ValorCampo>>;
  /** El que devolvio contratos_validar para este mensaje. Obligatorio. */
  comprobante?: string;
}

export function registrarValidacion(
  datosOriginales: Extraccion,
  juicioOriginal: Validacion,
  opciones: OpcionesRegistro,
): ResultadoRegistro | string {
  let datos = datosOriginales;
  let juicio = juicioOriginal;
  const mensajeId = juicio.mensaje_id;
  const fechaRegistro = opciones.hoy ?? hoyIso();
  const ts = new Date().toISOString();

  // El flujo no es una recomendacion del prompt: es una precondicion.
  // Sin el comprobante de contratos_validar no se escribe nada, y no se
  // puede obtener sin haber llamado a esa herramienta.
  const esperado = comprobanteDe(datosOriginales, juicioOriginal);
  if (opciones.comprobante === undefined || opciones.comprobante === "") {
    return `falta el comprobante de validacion. Llama primero a contratos_validar con mensaje_id "${mensajeId}" y pasa aqui el campo "comprobante" que devuelve. Sin validar no se registra: la persona que aprueba necesita ver la clasificacion. No se ha escrito nada.`;
  }
  if (opciones.comprobante !== esperado) {
    return `el comprobante no corresponde al estado actual de "${mensajeId}". O no salio de contratos_validar, o el maestro cambio despues de validar y la clasificacion que se aprobo ya no aplica. Vuelve a llamar a contratos_validar y reintenta con el comprobante nuevo. No se ha escrito nada.`;
  }

  const correcciones = opciones.correcciones ?? {};
  const pedidas = Object.keys(correcciones);
  let aplicadas: readonly CorreccionAplicada[] = [];
  let correccionesIgnoradas: readonly string[] = [];

  if (pedidas.length > 0 && !opciones.confirmado) {
    // Se ignoran, no se aplican a medias, y se reporta: una correccion sin
    // confirmacion humana es exactamente el dato que el modelo no puede
    // colar por su cuenta.
    correccionesIgnoradas = pedidas;
  } else if (pedidas.length > 0) {
    const resultado = aplicarCorrecciones(
      datosOriginales,
      juicioOriginal.campos_en_revision,
      correcciones,
    );
    if (typeof resultado === "string") {
      return resultado;
    }
    aplicadas = resultado.aplicadas;
    datos = resultado.datos;
    // Se revalida con los valores corregidos: una correccion puede cambiar
    // la clasificacion (un valor corregido que coincide con el maestro
    // convierte una actualizacion en duplicado).
    juicio = validarExtraccion(datos);
  }

  const idContrato = juicio.id_contrato;

  // Idempotencia: la llave es el mensaje, no el contrato. Dos mensajes
  // distintos pueden tocar el mismo contrato (un otrosi sobre una fila que
  // ya existe), asi que deduplicar por id_contrato romperia RN2.
  if (leerProcesados().has(mensajeId)) {
    return {
      mensaje_id: mensajeId,
      id_contrato: idContrato,
      accion: "ya_procesado",
      ruta_archivo: null,
      archivado: null,
      comercial: juicio.comercial.nombre ?? juicio.comercial.email,
      comercial_resuelto: juicio.comercial.conocido,
      estado_poliza: "",
      cambios: [],
      escrituras: [],
      aviso: `"${mensajeId}" ya estaba en ${RUTA_PROCESADOS}: no se escribe nada y el estado deseado ya se cumple`,
      ...sinFila(aplicadas, correccionesIgnoradas),
    };
  }

  // RN5. Se evalua antes que la clasificacion para que el rechazo por
  // confianza sea uniforme y predecible.
  if (juicio.requiere_revision.length > 0 && !opciones.confirmado) {
    return `requiere revision: ${juicio.requiere_revision.join("; ")}. Faltan por confirmar ${juicio.requiere_revision.length} campos; vuelve a llamar con confirmado: true cuando un humano los apruebe. No se ha escrito nada.`;
  }

  // RN1. Un duplicado no se registra nunca, ni con confirmado true.
  // Sobre de ERROR, no de exito: llamar a registrar sobre un duplicado es
  // un uso incorrecto de la herramienta, y un ok invitaria al agente a
  // decir "registrado". Lo que corresponde a un duplicado es reportarlo,
  // y eso ya lo hizo contratos_validar.
  if (juicio.clasificacion === "duplicado") {
    return `"${mensajeId}" es un DUPLICADO de ${juicio.coincidencia?.id_contrato ?? idContrato ?? "(sin id)"}: mismo id_contrato y mismos valor, fecha_inicio y fecha_fin. RN1: no se escribe nada, ni siquiera con confirmado true. No se ha escrito nada.`;
  }

  // RN4. Un rechazado tampoco se registra, y desde esta version NO marca
  // el mensaje como procesado: no escribe absolutamente nada. Ver S-27,
  // que documenta el cambio y su consecuencia sobre el buzon.
  if (juicio.clasificacion === "rechazado") {
    return `"${mensajeId}" esta RECHAZADO (RN4): ${juicio.motivo ?? "no es materia contractual"}. No hay nada que registrar y no se escribe nada.`;
  }

  if (idContrato === null) {
    return `no se puede registrar "${mensajeId}": el documento no tiene id_contrato legible`;
  }

  const abierto = abrirMensaje(mensajeId);
  if (typeof abierto === "string") {
    return abierto;
  }

  const escrituras: string[] = [];

  // (a) RN6: copia del fixture en la primera escritura.
  if (asegurarCopiaMaestro()) {
    escrituras.push(`${RUTA_MAESTRO_SHAREPOINT} (copia inicial del fixture)`);
  }
  const maestro = leerMaestro();
  const indice = maestro.filas.findIndex(
    (fila) => fila.id_contrato === idContrato,
  );
  const anterior: FilaMaestro = maestro.filas[indice] ?? {};
  const esActualizacion = indice !== -1;

  const fechaCorreo = fechaDelCorreo(mensajeId);
  const archivado = resolverAnio(
    datos.campos,
    abierto.texto,
    datos.tipo_documento,
    fechaCorreo,
  );

  // (b) copia del adjunto. El maestro guarda la ruta con barras normales.
  const cliente = comoTexto(datos.campos.cliente.valor) ?? anterior.cliente ?? "";
  const extension = extname(abierto.adjunto) || ".txt";
  const rutaRelativa = [
    CARPETA_CONTRATOS,
    archivado.anio,
    comoSegmentoDeRuta(cliente),
    `${idContrato}${extension}`,
  ].join("/");
  const destino = join(RAIZ_SHAREPOINT, ...rutaRelativa.split("/"));
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, abierto.texto, "utf8");
  escrituras.push(destino);

  // (a) fila: se parte de lo que ya habia y solo se pisa lo que el
  // documento aporta. Un campo no_aplica, o uno sin valor, conserva lo del
  // maestro en vez de sobrescribirse con null.
  const fila: Record<string, string> = { ...anterior };
  // Trazabilidad: cada columna dice de donde salio su valor.
  const procedencia: Record<string, string> = {};
  fila.id_contrato = idContrato;
  procedencia.id_contrato = "documento";
  for (const nombre of NOMBRES_CAMPO) {
    if (nombre === "id_contrato") {
      continue;
    }
    const campo = datos.campos[nombre];
    if (campo.estado === "no_aplica") {
      procedencia[nombre] = esActualizacion
        ? "maestro (no aplica a este tipo de documento)"
        : "vacio (no aplica a este tipo de documento)";
      continue;
    }
    const texto = comoTexto(campo.valor);
    if (texto === null) {
      if (!esActualizacion) {
        fila[nombre] = "";
        procedencia[nombre] = "vacio (el documento no lo determina)";
      } else {
        procedencia[nombre] = "maestro (el documento no lo determina)";
      }
      continue;
    }
    fila[nombre] = texto;
    procedencia[nombre] =
      campo.estado === "confirmado" ? "humano" : "documento";
  }

  // 7.2 fija el objeto en 200 caracteres. Recortar aqui, antes de validar.
  if (fila.objeto !== undefined) {
    fila.objeto = recortarObjeto(fila.objeto);
  }

  fila.estado_poliza = resolverEstadoPoliza(
    datos.campos.requiere_poliza.valor,
    esActualizacion,
    anterior.estado_poliza ?? "",
    soloCambios(juicio.diferencias),
  );
  // Decision 4: nunca se inventa un nombre. Si el remitente no resuelve,
  // la columna lleva el email, que es un dato real y visiblemente no es un
  // nombre. Ver S-15 para el coste de esta decision.
  fila.comercial = juicio.comercial.nombre ?? juicio.comercial.email;
  fila.ruta_sharepoint = rutaRelativa;
  fila.fecha_registro = fechaRegistro;
  fila.fuente = "buzon";
  procedencia.estado_poliza = "metadato de registro";
  procedencia.comercial = juicio.comercial.conocido
    ? "comerciales.json"
    : "correo (remitente no resuelto)";
  procedencia.ruta_sharepoint = `metadato de registro (${archivado.origen})`;
  procedencia.fecha_registro = "metadato de registro";
  procedencia.fuente = "metadato de registro";

  // El esquema 7.2 es normativo: la fila se valida ANTES de tocar el
  // disco. Si no cumple, no se escribe nada. Ya se copio el adjunto, pero
  // un archivo huerfano en out\ es recuperable; una fila corrupta en el
  // maestro se propaga a las alertas y nadie la ve.
  const problemas = validarFilaContraEsquema(fila);
  if (problemas.length > 0) {
    const detalle = problemas
      .map((uno) => `${uno.columna}="${uno.valor}": ${uno.motivo}`)
      .join("; ");
    return `la fila de "${mensajeId}" no cumple el esquema del maestro (PRD 7.2) y NO se ha escrito: ${detalle}`;
  }

  const filas = [...maestro.filas];
  if (esActualizacion) {
    filas[indice] = fila;
  } else {
    filas.push(fila);
  }
  escribirMaestro(filas);
  if (!escrituras.includes(RUTA_MAESTRO_SHAREPOINT)) {
    escrituras.push(RUTA_MAESTRO_SHAREPOINT);
  }

  const accion = esActualizacion ? "actualizacion" : "nuevo";

  // Campos que seguian bajo el corte y nadie corrigio. Se registra igual
  // —confirmar es un acto deliberado sobre lo que el bloque de
  // confirmacion mostro—, pero quedan nombrados en la respuesta y en el
  // historial. Ver S-21.
  const revisionSinCorregir = juicio.campos_en_revision;

  // (c) historial. Superset de las cinco claves que nombra HU-4: se anade
  // "archivado" para que el anio y su procedencia sean auditables.
  mkdirSync(RAIZ_SHAREPOINT, { recursive: true });
  appendFileSync(
    RUTA_HISTORIAL,
    `${JSON.stringify({
      ts,
      id_contrato: idContrato,
      accion,
      cambios: soloCambios(juicio.diferencias),
      mensaje_id: mensajeId,
      archivado,
      // Trazabilidad: que campos NO salieron del documento, y con que
      // valor exacto los aporto una persona.
      correcciones: aplicadas,
      revision_sin_corregir: revisionSinCorregir,
      procedencia,
    })}\n`,
    "utf8",
  );
  escrituras.push(RUTA_HISTORIAL);

  // (d) procesados. Va el ULTIMO a proposito: si el proceso muere antes,
  // el reintento vuelve a correr y como mucho duplica una linea del
  // historial. Al reves dejaria el mensaje marcado sin registrar, que es
  // perdida de datos en silencio.
  const falloMarca = marcarProcesado(mensajeId, idContrato, accion, ts);
  if (falloMarca !== null) {
    // La fila y el archivo YA se escribieron. Se reporta en vez de
    // callar: el mensaje quedara sin marcar y volvera a aparecer en el
    // buzon, lo que es recuperable; perder el historial no lo es.
    return `el contrato se registro, pero no se pudo marcar el mensaje como procesado. ${falloMarca}`;
  }
  escrituras.push(RUTA_PROCESADOS);

  return {
    mensaje_id: mensajeId,
    id_contrato: idContrato,
    accion,
    ruta_archivo: rutaRelativa,
    archivado,
    comercial: fila.comercial,
    comercial_resuelto: juicio.comercial.conocido,
    estado_poliza: fila.estado_poliza,
    cambios: soloCambios(juicio.diferencias),
    escrituras,
    aviso: juicio.comercial.conocido
      ? null
      : `remitente no resuelto: la columna comercial lleva el email "${juicio.comercial.email}" en vez de un nombre`,
    correcciones: aplicadas,
    correcciones_ignoradas: correccionesIgnoradas,
    revision_sin_corregir: revisionSinCorregir,
    procedencia,
    resumen_procedencia: resumirProcedencia(
      aplicadas,
      revisionSinCorregir,
      correccionesIgnoradas,
    ),
  };
}

/** La trazabilidad en una frase, para que se lea en el chat sin abrir el
 *  historial. */
function resumirProcedencia(
  aplicadas: readonly CorreccionAplicada[],
  sinCorregir: readonly NombreCampo[],
  ignoradas: readonly string[],
): string {
  const partes: string[] = [];
  if (aplicadas.length === 0) {
    partes.push("todos los campos salieron del documento");
  } else {
    const detalle = aplicadas
      .map((una) => `${una.campo}=${JSON.stringify(una.valor)}`)
      .join(", ");
    partes.push(
      `${aplicadas.length} ${aplicadas.length === 1 ? "campo lo aporto" : "campos los aporto"} una persona: ${detalle}; el resto salio del documento`,
    );
  }
  if (sinCorregir.length > 0) {
    partes.push(
      `${sinCorregir.length} siguen sin determinar y se registraron asi por confirmacion explicita: ${sinCorregir.join(", ")}`,
    );
  }
  if (ignoradas.length > 0) {
    partes.push(
      `se ignoraron ${ignoradas.length} correcciones por falta de confirmacion: ${ignoradas.join(", ")}`,
    );
  }
  return partes.join(". ");
}

/** La fecha del correo en YYYY-MM-DD, ultimo eslabon de la cadena. */
function fechaDelCorreo(mensajeId: string): string | null {
  for (const carpeta of carpetasDelBuzon()) {
    const correo = leerCorreo(carpeta);
    if (correo !== null && correo.id === mensajeId) {
      const fecha = /^(\d{4}-\d{2}-\d{2})/u.exec(correo.fecha);
      return fecha === null ? null : (fecha[1] ?? null);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Alertas (HU-5). Escribe out/alertas.md y nada mas.
// ---------------------------------------------------------------------------

/** Dias entre dos fechas ISO. Negativo si la segunda ya paso. */
function diasEntre(desde: string, hasta: string): number | null {
  const a = new Date(`${desde}T00:00:00Z`).getTime();
  const b = new Date(`${hasta}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return null;
  }
  return Math.round((b - a) / 86_400_000);
}

export interface AlertaVencimiento {
  id_contrato: string;
  cliente: string;
  fecha_fin: string;
  /** Negativo si ya vencio. */
  dias: number;
  valor: string;
  moneda: string;
  comercial: string;
}

export interface AlertaPoliza {
  id_contrato: string;
  cliente: string;
  tipo_poliza: string;
  estado_poliza: string;
  fecha_fin: string;
  comercial: string;
}

export interface AlertaRegistro {
  id_contrato: string;
  cliente: string;
  fecha_registro: string;
  fuente: string;
}

export interface RemitenteNoResuelto {
  email: string;
  /** Donde se detecto: en el buzon, en el maestro, o en ambos. */
  origen: string;
  detalle: string;
}

export interface Alertas {
  /** Fecha de corte con la que se calculo TODO lo de abajo. */
  hoy: string;
  ruta: string;
  fuente_maestro: string;
  ventana_dias: number;
  vencidos: readonly AlertaVencimiento[];
  vencen: readonly AlertaVencimiento[];
  polizas_pendientes: readonly AlertaPoliza[];
  registrados_desde_corte: readonly AlertaRegistro[];
  remitentes_no_resueltos: readonly RemitenteNoResuelto[];
  /** Filas sin fecha de terminacion: no se pueden vigilar. */
  sin_fecha_fin: readonly string[];
  total_alertas: number;
  /** Una frase para que el agente lo cuente en el chat. */
  resumen: string;
}

function comoVencimiento(fila: FilaMaestro, dias: number): AlertaVencimiento {
  return {
    id_contrato: fila.id_contrato ?? "",
    cliente: fila.cliente ?? "",
    fecha_fin: fila.fecha_fin ?? "",
    dias,
    valor: fila.valor ?? "",
    moneda: fila.moneda ?? "",
    comercial: fila.comercial ?? "",
  };
}

/** Los emails de comerciales.json, en minusculas. */
function emailsConocidos(): ReadonlySet<string> {
  const conocidos = new Set<string>();
  if (!existsSync(RUTA_COMERCIALES)) {
    return conocidos;
  }
  try {
    const crudo: unknown = JSON.parse(readFileSync(RUTA_COMERCIALES, "utf8"));
    const esquema = z.array(z.object({ email: z.string() }));
    const analizado = esquema.safeParse(crudo);
    if (analizado.success) {
      for (const fila of analizado.data) {
        conocidos.add(fila.email.toLowerCase());
      }
    }
  } catch {
    return conocidos;
  }
  return conocidos;
}

/**
 * Remitentes que no resuelven contra comerciales.json. Se miran los dos
 * sitios donde el hueco deja rastro: el buzon (quien envio) y la columna
 * comercial del maestro, que por S-15 lleva el email cuando no hubo
 * nombre. Sin esta seccion el email documenta el hueco y nadie lo cierra.
 */
function remitentesNoResueltos(
  maestro: Maestro,
): readonly RemitenteNoResuelto[] {
  const conocidos = emailsConocidos();
  const hallados = new Map<string, { buzon: string[]; maestro: string[] }>();

  for (const carpeta of carpetasDelBuzon()) {
    const correo = leerCorreo(carpeta);
    if (correo === null || conocidos.has(correo.de.toLowerCase())) {
      continue;
    }
    const clave = correo.de.toLowerCase();
    const entrada = hallados.get(clave) ?? { buzon: [], maestro: [] };
    entrada.buzon.push(correo.id);
    hallados.set(clave, entrada);
  }

  for (const fila of maestro.filas) {
    const comercial = fila.comercial ?? "";
    if (!comercial.includes("@") || conocidos.has(comercial.toLowerCase())) {
      continue;
    }
    const clave = comercial.toLowerCase();
    const entrada = hallados.get(clave) ?? { buzon: [], maestro: [] };
    entrada.maestro.push(fila.id_contrato ?? "");
    hallados.set(clave, entrada);
  }

  return [...hallados.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([email, donde]) => {
      const partes: string[] = [];
      if (donde.buzon.length > 0) {
        partes.push(`envio ${donde.buzon.sort().join(", ")}`);
      }
      if (donde.maestro.length > 0) {
        partes.push(
          `figura como comercial en ${donde.maestro.sort().join(", ")}`,
        );
      }
      const origen =
        donde.buzon.length > 0 && donde.maestro.length > 0
          ? "buzon y maestro"
          : donde.buzon.length > 0
            ? "buzon"
            : "maestro";
      return { email, origen, detalle: partes.join("; ") };
    });
}

export function construirAlertas(hoy: string): Alertas {
  const maestro = leerMaestro();

  const vencidos: AlertaVencimiento[] = [];
  const vencen: AlertaVencimiento[] = [];
  const polizas: AlertaPoliza[] = [];
  const registrados: AlertaRegistro[] = [];
  const sinFechaFin: string[] = [];

  for (const fila of maestro.filas) {
    const fin = fila.fecha_fin ?? "";
    if (fin === "") {
      sinFechaFin.push(fila.id_contrato ?? "");
    } else {
      const dias = diasEntre(hoy, fin);
      if (dias === null) {
        sinFechaFin.push(fila.id_contrato ?? "");
      } else if (dias < 0) {
        // Ya vencido: grupo aparte, no dentro de "vencen en 60 dias".
        // Son acciones distintas y publicos distintos. Ver S-23.
        vencidos.push(comoVencimiento(fila, dias));
      } else if (dias <= VENTANA_DIAS) {
        vencen.push(comoVencimiento(fila, dias));
      }
    }

    if ((fila.requiere_poliza ?? "") === "true" && (fila.estado_poliza ?? "") !== "vigente") {
      polizas.push({
        id_contrato: fila.id_contrato ?? "",
        cliente: fila.cliente ?? "",
        tipo_poliza: fila.tipo_poliza ?? "",
        estado_poliza: fila.estado_poliza ?? "",
        fecha_fin: fin,
        comercial: fila.comercial ?? "",
      });
    }

    const registro = fila.fecha_registro ?? "";
    if (registro !== "" && registro >= CORTE_GAP) {
      registrados.push({
        id_contrato: fila.id_contrato ?? "",
        cliente: fila.cliente ?? "",
        fecha_registro: registro,
        fuente: fila.fuente ?? "",
      });
    }
  }

  // Orden estable: el reporte debe salir identico en dos corridas.
  const porFecha = (a: AlertaVencimiento, b: AlertaVencimiento): number =>
    a.fecha_fin === b.fecha_fin
      ? a.id_contrato.localeCompare(b.id_contrato)
      : a.fecha_fin.localeCompare(b.fecha_fin);
  vencidos.sort(porFecha);
  vencen.sort(porFecha);
  polizas.sort((a, b) => a.id_contrato.localeCompare(b.id_contrato));
  registrados.sort((a, b) =>
    a.fecha_registro === b.fecha_registro
      ? a.id_contrato.localeCompare(b.id_contrato)
      : a.fecha_registro.localeCompare(b.fecha_registro),
  );
  sinFechaFin.sort();

  const remitentes = remitentesNoResueltos(maestro);
  const total =
    vencidos.length + vencen.length + polizas.length + remitentes.length;

  return {
    hoy,
    ruta: RUTA_ALERTAS,
    fuente_maestro: maestro.fuente,
    ventana_dias: VENTANA_DIAS,
    vencidos,
    vencen,
    polizas_pendientes: polizas,
    registrados_desde_corte: registrados,
    remitentes_no_resueltos: remitentes,
    sin_fecha_fin: sinFechaFin,
    total_alertas: total,
    resumen:
      `Al ${hoy}: ${vencidos.length} ${vencidos.length === 1 ? "contrato ya vencido" : "contratos ya vencidos"}, ` +
      `${vencen.length} ${vencen.length === 1 ? "vence" : "vencen"} en ${VENTANA_DIAS} dias o menos, ` +
      `${polizas.length} con poliza exigida sin vigencia confirmada y ` +
      `${remitentes.length} ${remitentes.length === 1 ? "remitente sin resolver" : "remitentes sin resolver"}. ` +
      `${registrados.length} ${registrados.length === 1 ? "contrato registrado" : "contratos registrados"} desde ${CORTE_GAP}.`,
  };
}

function tabla(
  encabezados: readonly string[],
  filas: readonly (readonly string[])[],
): string {
  const lineas = [
    `| ${encabezados.join(" | ")} |`,
    `|${encabezados.map(() => "---").join("|")}|`,
  ];
  for (const fila of filas) {
    lineas.push(`| ${fila.join(" | ")} |`);
  }
  return lineas.join("\n");
}

function seccion(titulo: string, cuerpo: string): string {
  return `## ${titulo}\n\n${cuerpo}\n`;
}

/**
 * El markdown. Todo lo que hay aqui es funcion de (hoy, maestro) salvo la
 * linea "Generado:", que es la unica no determinista del archivo.
 */
function redactarAlertas(alertas: Alertas, sello: string): string {
  const partes: string[] = [];
  partes.push("# Alertas de contratos\n");
  partes.push(
    [
      `- **Fecha de corte:** ${alertas.hoy}`,
      `- **Maestro leido:** \`${alertas.fuente_maestro}\``,
      `- **Ventana de vencimiento:** ${alertas.ventana_dias} dias`,
      `- **Gap vigilado desde:** ${CORTE_GAP}`,
      `Generado: ${sello}`,
      "",
      `> ${alertas.resumen}`,
      "",
    ].join("\n"),
  );

  partes.push(
    seccion(
      `1. Contratos ya vencidos (${alertas.vencidos.length})`,
      alertas.vencidos.length === 0
        ? "Ninguno a la fecha de corte."
        : [
            "Vencidos antes de la fecha de corte. O el servicio se esta prestando sin",
            "contrato vigente, o la terminacion nunca se registro. Requiere revision",
            "legal o de datos, no renovacion.",
            "",
            tabla(
              ["Contrato", "Cliente", "Vencio", "Hace", "Valor", "Comercial"],
              alertas.vencidos.map((fila) => [
                fila.id_contrato,
                fila.cliente,
                fila.fecha_fin,
                `${Math.abs(fila.dias)} dias`,
                `${fila.moneda} ${fila.valor}`,
                fila.comercial,
              ]),
            ),
          ].join("\n"),
    ),
  );

  partes.push(
    seccion(
      `2. Vencen en ${alertas.ventana_dias} dias o menos (${alertas.vencen.length})`,
      alertas.vencen.length === 0
        ? "Ninguno en la ventana."
        : tabla(
            ["Contrato", "Cliente", "Vence", "Faltan", "Valor", "Comercial"],
            alertas.vencen.map((fila) => [
              fila.id_contrato,
              fila.cliente,
              fila.fecha_fin,
              `${fila.dias} dias`,
              `${fila.moneda} ${fila.valor}`,
              fila.comercial,
            ]),
          ),
    ),
  );

  partes.push(
    seccion(
      `3. Poliza exigida sin vigencia confirmada (${alertas.polizas_pendientes.length})`,
      alertas.polizas_pendientes.length === 0
        ? "Ninguno: todas las polizas exigidas estan vigentes."
        : tabla(
            ["Contrato", "Cliente", "Tipo", "Estado", "Vence", "Comercial"],
            alertas.polizas_pendientes.map((fila) => [
              fila.id_contrato,
              fila.cliente,
              fila.tipo_poliza === "" ? "(sin tipo)" : fila.tipo_poliza,
              fila.estado_poliza === "" ? "(vacio)" : fila.estado_poliza,
              fila.fecha_fin === "" ? "(sin fecha)" : fila.fecha_fin,
              fila.comercial,
            ]),
          ),
    ),
  );

  partes.push(
    seccion(
      `4. Registrados desde ${CORTE_GAP} (${alertas.registrados_desde_corte.length})`,
      alertas.registrados_desde_corte.length === 0
        ? `Ninguno: el gap desde ${CORTE_GAP} sigue sin cubrir.`
        : tabla(
            ["Contrato", "Cliente", "Registrado", "Fuente"],
            alertas.registrados_desde_corte.map((fila) => [
              fila.id_contrato,
              fila.cliente,
              fila.fecha_registro,
              fila.fuente,
            ]),
          ),
    ),
  );

  partes.push(
    seccion(
      `5. Remitentes sin resolver (${alertas.remitentes_no_resueltos.length})`,
      alertas.remitentes_no_resueltos.length === 0
        ? "Ninguno: todos los remitentes resuelven contra comerciales.json."
        : [
            "Direcciones que enviaron contratos o figuran como comercial y no estan en",
            "`comerciales.json`. Mientras sigan aqui, la columna comercial del maestro",
            "guarda un email en vez de un nombre. Se cierra anadiendolas al fichero.",
            "",
            tabla(
              ["Remitente", "Detectado en", "Detalle"],
              alertas.remitentes_no_resueltos.map((fila) => [
                fila.email,
                fila.origen,
                fila.detalle,
              ]),
            ),
          ].join("\n"),
    ),
  );

  if (alertas.sin_fecha_fin.length > 0) {
    partes.push(
      seccion(
        `6. Sin fecha de terminacion (${alertas.sin_fecha_fin.length})`,
        [
          "Filas que no se pueden vigilar: sin fecha de terminacion no hay vencimiento",
          "que calcular. Quedan fuera de los grupos 1 y 2 y no vuelven a aparecer solas.",
          "",
          alertas.sin_fecha_fin.map((id) => `- ${id}`).join("\n"),
        ].join("\n"),
      ),
    );
  }

  return `${partes.join("\n")}\n`;
}

export function generarAlertas(hoy: string): Alertas {
  const alertas = construirAlertas(hoy);
  mkdirSync(dirname(RUTA_ALERTAS), { recursive: true });
  writeFileSync(
    RUTA_ALERTAS,
    redactarAlertas(alertas, new Date().toISOString()),
    "utf8",
  );
  return alertas;
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

/** Se registra como contratos_leer_buzon. */
export const leer_buzon = definir({
  description:
    "Lista los mensajes del buzon de contratos que todavia no han sido procesados. Devuelve por mensaje el id, el remitente, el asunto, la fecha, los adjuntos y si trae un documento contractual. No escribe nada.",
  args: z.object({}),
  execute: () => {
    const pendientes = listarPendientes();
    return respuestaOk({
      total: pendientes.length,
      mensajes: pendientes,
    });
  },
});

/** Se registra como contratos_extraer. */
export const extraer = definir({
  description:
    "Lee el adjunto de un mensaje del buzon y extrae los campos del contrato con una confianza por campo entre 0 y 1. La extraccion es determinista: no adivina ni rellena. Un campo que no esta en el texto sale null con confianza 0. No escribe nada.",
  args: z.object({
    mensaje_id: z
      .string()
      .min(1)
      .describe('Id del mensaje del buzon, por ejemplo "msg-001".'),
  }),
  execute: ({ mensaje_id }) => {
    const resultado = extraerDeMensaje(mensaje_id);
    if (typeof resultado === "string") {
      return respuestaError(resultado);
    }
    return respuestaOk(resultado);
  },
});

const esquemaCampo = z.object({
  valor: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  confianza: z.number().min(0).max(1),
  estado: z.enum([
    "leido",
    "deducido",
    "derivado",
    "parcial",
    "ausente",
    "no_aplica",
    "confirmado",
  ]),
  nota: z.string().nullable(),
});

const esquemaExtraccion = z.object({
  mensaje_id: z.string().min(1),
  adjunto: z.string().nullable(),
  tipo_documento: z.enum([
    "contrato",
    "contrato_marco",
    "otrosi",
    "cotizacion",
    "desconocido",
  ]),
  extraible: z.boolean(),
  valor_indeterminado: z.boolean(),
  campos: z.object({
    id_contrato: esquemaCampo,
    cliente: esquemaCampo,
    nit_cliente: esquemaCampo,
    pais: esquemaCampo,
    objeto: esquemaCampo,
    valor: esquemaCampo,
    moneda: esquemaCampo,
    fecha_inicio: esquemaCampo,
    fecha_fin: esquemaCampo,
    requiere_poliza: esquemaCampo,
    tipo_poliza: esquemaCampo,
  }),
  requiere_revision: z.array(z.enum(NOMBRES_CAMPO)),
  corte_revision: z.number(),
  motivo: z.string().nullable(),
});

/** Se registra como contratos_validar. */
export const validar = definir({
  description:
    "Clasifica el resultado de contratos_extraer en nuevo, actualizacion, duplicado o rechazado comparandolo contra el maestro de contratos. Devuelve los campos que requieren revision, los cambios y conflictos frente al maestro, y el comercial resuelto a partir del remitente. No escribe nada.",
  args: z.object({
    mensaje_id: z
      .string()
      .min(1)
      .describe('Id del mensaje del buzon, por ejemplo "msg-003".'),
    extraccion: esquemaExtraccion
      .optional()
      .describe(
        "Resultado de contratos_extraer. Si se omite, se vuelve a extraer del buzon: la extraccion es determinista y da el mismo resultado.",
      ),
  }),
  execute: ({ mensaje_id, extraccion }) => {
    if (extraccion !== undefined) {
      if (extraccion.mensaje_id !== mensaje_id) {
        return respuestaError(
          `la extraccion es de "${extraccion.mensaje_id}" y el mensaje_id pedido es "${mensaje_id}"`,
        );
      }
      return respuestaOk(validarExtraccion(extraccion));
    }
    const resultado = extraerDeMensaje(mensaje_id);
    if (typeof resultado === "string") {
      return respuestaError(resultado);
    }
    return respuestaOk(validarExtraccion(resultado));
  },
});

/**
 * Se registra como contratos_registrar. Es la UNICA herramienta que
 * escribe, y la unica que debe entrar en requierenConfirmacion.
 */
export const registrar = definir({
  description:
    "Escribe el contrato en el maestro de out/sharepoint, archiva el adjunto, deja una linea en el historial y marca el mensaje como procesado. EXIGE haber llamado antes a contratos_validar: hay que pasarle el comprobante que esa devuelve. Solo escribe si no hay campos por revisar o si confirmado es true. Un duplicado o un rechazado no escriben nada. Es la unica herramienta que modifica archivos.",
  args: z.object({
    mensaje_id: z
      .string()
      .min(1)
      .describe('Id del mensaje del buzon, por ejemplo "msg-001".'),
    confirmado: z
      .boolean()
      .default(false)
      .describe(
        "true solo si un humano aprobo explicitamente los campos que quedaron por revisar. Sin esto, un contrato con campos dudosos no se escribe.",
      ),
    // Opcional en el esquema, obligatorio en la ejecucion: asi el fallo
    // sale con un mensaje que le dice al modelo que hacer ("llama primero
    // a contratos_validar") en vez del "expected string, received
    // undefined" de zod, que no guia a nadie. La garantia es la misma.
    comprobante: z
      .string()
      .optional()
      .describe(
        'El campo "comprobante" que devolvio contratos_validar para este mismo mensaje. Obligatorio: sin el no se escribe nada. Si el maestro cambio despues de validar, vuelve a validar y usa el nuevo.',
      ),
    hoy: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional()
      .describe(
        "Fecha de registro en formato YYYY-MM-DD. Si se omite se usa la de hoy.",
      ),

    /*
     * COMO SE EVITA QUE EL MODELO INVENTE UN DATO Y LO CUELE POR LA
     * CONFIRMACION.
     *
     * Este mapa lo compone el modelo. No hay otra forma: el modelo es
     * quien arma los argumentos de la llamada. Eso se acepta porque hay
     * cuatro cierres encadenados, y ninguno depende de que el modelo se
     * porte bien.
     *
     * 1. El conjunto de campos corregibles NO lo propone el modelo. Lo
     *    calcula esta herramienta volviendo a correr el extractor y el
     *    validador deterministas, y es exactamente
     *    Validacion.campos_en_revision. Una correccion sobre un campo
     *    fuera de ese conjunto se rechaza con sobre de error. Este es el
     *    cierre que aguanta el peso: el modelo NUNCA puede aportar un
     *    valor para un campo que el documento afirma con claridad. Lo
     *    peor que puede hacer es dar un valor equivocado para un campo que
     *    el extractor ya habia marcado como desconocido y que ya estaba
     *    bloqueando el registro.
     *
     * 2. El valor se valida contra ESQUEMA_POR_CAMPO antes de tocar nada.
     *    Una fecha que no es YYYY-MM-DD, o que no existe en el calendario,
     *    no entra. Confirmar no exime de tener la forma correcta.
     *
     * 3. Sin confirmado: true las correcciones se ignoran enteras y se
     *    reportan en correcciones_ignoradas. Y confirmado: true por si
     *    solo no basta, porque tambien lo compone el modelo: lo que lo
     *    hace significar algo es que contratos_registrar esta en
     *    requierenConfirmacion, asi que el ciclo PARA la llamada y espera
     *    a una persona pase lo que pase en los argumentos. Son dos puertas
     *    independientes; la de la herramienta solo vale por la del ciclo.
     *
     * 4. Al confirmar, el modelo no recompone la llamada. El ciclo
     *    congela el objeto (ciclo.ts, LlamadaPendiente), muestra esos
     *    argumentos exactos, y ejecuta ESE objeto; el cliente solo puede
     *    enviar un booleano (server.ts) y no puede inyectar argumentos.
     *
     * DONDE ESTA FLOJO, dicho aqui y no solo en SUPUESTOS: el paso 4 se
     * apoya en que un humano lea un volcado JSON. Si el modelo escribe
     * 2027-08-13 en vez de 2027-08-31, un clic distraido lo deja pasar.
     * Por eso todo valor confirmado queda con estado "confirmado",
     * procedencia "humano" en la fila y su valor exacto en
     * historial.jsonl: no impide el error, pero lo vuelve atribuible en
     * vez de indistinguible de una lectura del documento. Ver S-20.
     */
    correcciones: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean()]),
      )
      .optional()
      .describe(
        "Valores que una persona aporto para campos que quedaron en revision, como {\"fecha_fin\": \"2027-08-31\"}. Solo se aplica junto a confirmado: true, y solo sobre campos que aparecen en requiere_revision: corregir un campo que el documento afirma se rechaza.",
      ),
  }),
  execute: ({ mensaje_id, confirmado, hoy, correcciones, comprobante }) => {
    const datos = extraerDeMensaje(mensaje_id);
    if (typeof datos === "string") {
      return respuestaError(datos);
    }
    const juicio = validarExtraccion(datos);
    const resultado = registrarValidacion(datos, juicio, {
      confirmado,
      hoy,
      correcciones,
      comprobante,
    });
    if (typeof resultado === "string") {
      return respuestaError(resultado);
    }
    return respuestaOk(resultado);
  },
});

/**
 * Se registra como contratos_alertas. Escribe out/alertas.md y NADA mas:
 * no toca el maestro, ni el historial, ni procesados.
 *
 * NO entra en requierenConfirmacion. Generar un reporte no es una accion
 * con efecto sobre el negocio: es idempotente, no cambia ningun dato y
 * volver a correrla con la misma fecha produce el mismo archivo.
 */
export const alertas = definir({
  description:
    "Genera el reporte de riesgos en out/alertas.md a una fecha de corte dada: contratos ya vencidos, los que vencen en 60 dias o menos, los que exigen poliza sin vigencia confirmada, los registrados desde el inicio del gap y los remitentes que no resuelven contra comerciales.json. Devuelve tambien el resumen estructurado. No modifica el maestro.",
  args: z.object({
    /*
     * La fecha de corte es OBLIGATORIA y no tiene valor por defecto.
     *
     * Un reporte de vencimientos calculado contra Date.now() cambia de
     * respuesta cada dia sin que nadie toque el codigo, y los requisitos
     * no funcionales exigen que demo.ts sea reproducible entre corridas.
     *
     * Un argumento opcional con defecto "hoy" seria peor que cualquiera
     * de los dos extremos: las pruebas pasarian sin ejercitar nunca el
     * camino explicito, que es el unico que usa la demo.
     *
     * Y por CA2 el modelo no puede afirmar un valor que no haya salido de
     * una herramienta: si la fecha la pusiera esta funcion por su cuenta,
     * el modelo estaria contando en el chat un corte que nunca vio. Asi
     * viaja en la llamada, queda en out/log.jsonl por CA4 y se estampa en
     * la cabecera del propio alertas.md.
     */
    hoy: esquemaFecha.describe(
      'Fecha de corte en formato YYYY-MM-DD contra la que se calculan los vencimientos, por ejemplo "2026-09-03". Obligatoria: sin ella el reporte no seria reproducible.',
    ),
  }),
  execute: ({ hoy }) => respuestaOk(generarAlertas(hoy)),
});
