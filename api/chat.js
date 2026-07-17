// api/chat.js
// Vercel Serverless Function — AI chat assistant for ALTONEXO ACADEMY
// Uses Google Gemini API (free tier). The API key is read from an
// environment variable (GEMINI_API_KEY) configured in the Vercel dashboard —
// it is NEVER exposed to the browser.

const SYSTEM_PROMPT = `Eres el asistente virtual oficial de ALTONEXO ACADEMY, una academia de formación profesional en Punta Cana, República Dominicana.

INFORMACIÓN DE LA ACADEMIA:
- Nombre: ALTONEXO ACADEMY
- Eslogan: "Tu conexión con el éxito"
- Ubicación: Alto de Friusa, Av. España, Plaza Stephanie, Bávaro, Punta Cana, República Dominicana
- Horario: Lunes a Viernes, 8:00 AM – 10:30 PM
- Teléfonos: (809) 707-5097 y (829) 559-2737
- Correo: info@altonexoacademy.com
- WhatsApp: https://wa.me/18097075097

PROGRAMAS DISPONIBLES:
1. IDIOMAS: Inglés (turístico y conversacional, niveles Básico/Intermedio/Avanzado), Francés (niveles Básico/Intermedio/Avanzado), Español para extranjeros (niveles Básico/Intermedio)
2. BELLEZA: Uñas profesionales (acrílico, gel, nail art), Peluquería (corte, coloración), Trenzas & Extensiones (box braids, cornrows, knotless), Belleza integral (maquillaje, skincare, cejas)
3. TECNOLOGÍA: Computación e Internet (Office, Excel, Word)
4. FOTOGRAFÍA: Fotografía y edición (edición básica para PVC, botellas, vasos)

PLANES DE PRECIO (generales, sin montos exactos — siempre invita a contactar para cotización personalizada):
- Nivel Básico: por módulo, incluye material didáctico y certificado de finalización
- Programa Completo: acceso a los 3 niveles, seguimiento personalizado, certificación oficial
- Formación Profesional (Belleza/Tecnología): prácticas con modelos reales, kit de herramientas incluido, certificado profesional

LIBRO: "English Altonexo Academy — Libro 1" (curso de inglés en formato digital, 56 lecciones, nivel A0 a A1, precio $14.99, pago en efectivo en la oficina, disponible en la página /book1.html del sitio).

REGLAS DE COMPORTAMIENTO:
- Responde SIEMPRE en español, de forma cálida, breve y profesional (2-4 oraciones máximo).
- Si preguntan por precios exactos o inscripción, invita a contactar por WhatsApp o el formulario de contacto para una cotización personalizada — nunca inventes un monto específico.
- Si preguntan algo que no está en esta información, admite que no tienes ese dato y ofrece conectarlos con un asesor humano por WhatsApp.
- No inventes cursos, horarios ni datos que no estén listados arriba.
- Sé motivador y amable, como un buen asesor educativo.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, history } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing message' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server not configured (missing API key)' });
  }

  // Build conversation contents: previous turns + the new user message
  const contents = [];
  if (Array.isArray(history)) {
    for (const turn of history.slice(-10)) { // keep last 10 turns for context
      contents.push({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.text }],
      });
    }
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: {
            temperature: 0.6,
            maxOutputTokens: 300,
          },
        }),
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Gemini API error:', data);
      return res.status(502).json({ error: 'AI service error' });
    }

    const reply =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      'Lo siento, no pude generar una respuesta. ¿Puedes intentar de nuevo?';

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}