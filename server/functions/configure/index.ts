// MaxIA /configure - la IA llena los parametros de una herramienta procedural (flujo, precio fijo).
// La IA NO escribe geometria: devuelve JSON con parametros y el plugin genera la geometria localmente.
//   GET  -> { flows: { id: creditos } }
//   POST { flow, text, schema, guide, current, hint, images[] } -> { params, nota, credits, balance, bucket, pricing }
import { admin, getUser, settings, json, preflight } from "./supabase.ts";

const KEYS = { anthropic: Deno.env.get("ANTHROPIC_API_KEY") || "", moonshot: Deno.env.get("MOONSHOT_API_KEY") || "" };
const MAX_BODY = 8 * 1024 * 1024;

const SYSTEM = `Configuras herramientas procedurales de MaxIA (3ds Max, archviz). No escribes codigo ni geometria.
Responde SOLO con un objeto JSON: {"params": {...}, "nota": "maximo 12 palabras sobre lo que elegiste"}.
Reglas: usa solo las claves del esquema; numeros en las unidades del esquema (cm o grados) y dentro de min/max;
en campos de opcion usa exactamente uno de los valores listados; lo que el usuario no mencione conserva el valor actual.
Si hay imagen de referencia, estima proporciones reales (altura de piso ~300 cm). Responde en espanol.`;

// deno-lint-ignore no-explicit-any
type Any = any;

function parseJSON(text: string): Any {
  const t = (text || "").replace(/^```(json)?/m, "").replace(/```\s*$/m, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

function filterParams(params: Any, schema: Record<string, Any>) {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(schema || {})) {
    if (!params || !(k in params)) continue;
    const v = params[k];
    if (spec?.tipo === "opcion") { if ((spec.opciones || []).includes(String(v).toLowerCase())) out[k] = String(v).toLowerCase(); }
    else if (Number.isFinite(Number(v))) {
      let n = Number(v);
      if (spec?.min !== undefined) n = Math.max(Number(spec.min), n);
      if (spec?.max !== undefined) n = Math.min(Number(spec.max), n);
      out[k] = n;
    }
  }
  return out;
}

async function callModel(m: Any, userBlocks: Any[], hasImages: boolean, deadline: number) {
  const signal = AbortSignal.timeout(Math.max(5000, deadline - Date.now()));
  if (m.provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "x-api-key": KEYS.anthropic, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: m.model, max_tokens: 800, system: SYSTEM, messages: [{ role: "user", content: userBlocks }] }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw { status: r.status, detail: d?.error?.message || r.statusText };
    const text = (d.content || []).filter((b: Any) => b.type === "text").map((b: Any) => b.text).join("");
    const u = d.usage || {};
    return { text, usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
                            cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  }
  const content = userBlocks.map((b: Any) => b.type === "image"
    ? { type: "image_url", image_url: { url: `data:${b.source?.media_type || "image/jpeg"};base64,${b.source?.data || ""}` } }
    : { type: "text", text: b.text || "" });
  const r = await fetch("https://api.moonshot.ai/v1/chat/completions", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEYS.moonshot}` },
    body: JSON.stringify({ model: m.model, max_completion_tokens: 800, response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: hasImages ? content : content.map((c: Any) => c.text).join("\n") }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw { status: r.status, detail: d?.error?.message || r.statusText };
  const u = d.usage || {};
  const cached = u.cached_tokens || u.prompt_tokens_details?.cached_tokens || 0;
  return { text: d.choices?.[0]?.message?.content || "",
           usage: { input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached), output_tokens: u.completion_tokens || 0,
                    cache_read_input_tokens: cached, cache_creation_input_tokens: 0 } };
}

const costUSD = (m: Any, u: Any) => (u.input_tokens * Number(m.price_in) + u.output_tokens * Number(m.price_out) +
  u.cache_read_input_tokens * Number(m.price_cache_read)) / 1e6;

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  const tReq = Date.now();
  const user = await getUser(req);
  if (!user) return json({ error: "Sesion invalida. Vuelve a iniciar sesion." }, 401);

  if (req.method === "GET") {
    const { data } = await admin.from("maxia_flows").select("id,credits").eq("active", true);
    return json({ flows: Object.fromEntries((data || []).map((r: Any) => [r.id, Number(r.credits)])) });
  }
  if (req.method !== "POST") return json({ error: "Metodo no permitido" }, 405);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "La imagen es demasiado grande." }, 413);
  let body: Any;
  try { body = JSON.parse(raw); } catch { return json({ error: "Peticion invalida" }, 400); }

  const { data: flow } = await admin.from("maxia_flows").select("*").eq("id", String(body.flow || "")).eq("active", true).maybeSingle();
  if (!flow) return json({ error: "Esta herramienta no tiene flujo con IA disponible." }, 404);
  const price = Number(flow.credits) || 0;
  const images = (Array.isArray(body.images) ? body.images : []).filter((b: Any) => b?.type === "image").slice(0, 2);
  const text = String(body.text || "").slice(0, 2000);
  if (!text && !images.length) return json({ error: "Describe lo que quieres o adjunta una referencia." }, 400);

  // Kimi (barato) para texto; Opus si hay imagen (lectura visual mas confiable)
  const cfg = await settings();
  const modelId = String(images.length ? cfg.tier_max : cfg.tier_fast);
  const { data: m } = await admin.from("maxia_models").select("*").eq("model", modelId).eq("active", true).single();
  if (!m || !KEYS[m.provider as keyof typeof KEYS]) return json({ error: "Modelo no disponible" }, 500);
  const bucket = String(m.bucket);

  const { data: guard, error: gErr } = await admin.rpc("maxia_guard", { p_user: user.id, p_bucket: bucket });
  if (gErr) return json({ error: "Error interno (guard)" }, 500);
  if (!guard.active) return json({ error: "Tu cuenta esta desactivada." }, 403);
  if (Number(guard.balance) < price)
    return json({ error: `Este flujo (${flow.nombre}) cuesta ${price} creditos y tienes ${Number(guard.balance).toFixed(0)}. Recarga para continuar.`,
                  balance: Number(guard.balance) }, 402);
  if (Number(guard.last_min) >= Number(cfg.rate_per_minute ?? 30)) return json({ error: "Demasiadas peticiones por minuto. Espera un momento." }, 429);
  if (Number(guard.today) >= Number(cfg.daily_cap ?? 3000)) return json({ error: "Alcanzaste el limite diario de consumo." }, 429);

  const schema = body.schema && typeof body.schema === "object" ? body.schema : {};
  const prompt = [
    `HERRAMIENTA: ${flow.nombre}`,
    `ESQUEMA: ${JSON.stringify(schema).slice(0, 4000)}`,
    `VALORES ACTUALES: ${JSON.stringify(body.current || {}).slice(0, 2000)}`,
    body.guide ? `GUIA DEL ESTUDIO: ${String(body.guide).slice(0, 3000)}` : "",
    body.hint ? `ESCENA: ${String(body.hint).slice(0, 500)}` : "",
    `PETICION DEL USUARIO: ${text || "(solo imagen de referencia)"}`,
  ].filter(Boolean).join("\n");

  let out: Any;
  try {
    out = await callModel(m, [...images, { type: "text", text: prompt }], images.length > 0, tReq + 110000);
  } catch (e) {
    console.error("configure provider error", m.provider, (e as Any)?.status, (e as Any)?.detail);
    return json({ error: "El servicio de IA no respondio (no se cobro). Intenta de nuevo." }, 502);
  }
  const parsed = parseJSON(out.text);
  const params = filterParams(parsed?.params, schema);
  if (!parsed || !Object.keys(params).length)
    return json({ error: "La IA no devolvio parametros validos (no se cobro). Reformula la peticion." }, 422);

  const cost = costUSD(m, out.usage);
  const { data: balance, error: cErr } = await admin.rpc("maxia_charge", {
    p_user: user.id, p_bucket: bucket, p_credits: price,
    p_usage: { model: m.model, tier: `flujo:${flow.id}`,   // en maxia_usage queda que fue un flujo (para calibrar precio vs costo)
               input_tokens: out.usage.input_tokens,
               cache_read: out.usage.cache_read_input_tokens, cache_write: 0, output_tokens: out.usage.output_tokens,
               cost_usd: cost, latency_ms: Date.now() - tReq },
  });
  if (cErr) console.error("charge error", cErr);

  return json({ params, nota: String(parsed.nota || "").slice(0, 120), credits: price, bucket,
                balance: balance === null || balance === undefined ? null : Number(balance),
                pricing: { mode: "flujo", flow: flow.nombre, fixed: price, first: true } });
});
