// ============================================================
//  AI CHATBOT BACKEND — server.js
//  Дэмжих платформ: Website, Instagram, Facebook, WhatsApp
//  AI: Claude (Anthropic) + OpenAI
// ============================================================

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
app.use(express.json());
app.use(cors()); // Website widget-д зориулсан

// ---- Хэрэглэгчийн .env тохиргоо ----
const {
  CLAUDE_API_KEY,
  OPENAI_API_KEY,
  AI_PROVIDER       = 'claude',     // 'claude' эсвэл 'openai'
  META_VERIFY_TOKEN = 'mytoken123', // Facebook/Instagram webhook verify token
  META_PAGE_TOKEN,                  // Facebook Page access token
  WHATSAPP_TOKEN,                   // WhatsApp Business token
  WHATSAPP_PHONE_ID,                // WhatsApp phone number ID
  BOT_SYSTEM_PROMPT = 'Чи туслагч AI юм. Монгол хэлээр товч, тодорхой, найрсагаар хариул.',
  PORT              = 3000,
} = process.env;

// ============================================================
//  AI ДУУДАХ ФУНКЦУУД
// ============================================================

async function askClaude(userMessage, history = []) {
  const messages = [
    ...history,
    { role: 'user', content: userMessage }
  ];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: BOT_SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err?.error?.message || 'Claude API алдаа');
  }

  const data = await res.json();
  return data.content[0].text;
}

async function askOpenAI(userMessage, history = []) {
  const messages = [
    { role: 'system', content: BOT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userMessage }
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1024,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err?.error?.message || 'OpenAI API алдаа');
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// AI сонгогч — .env дахь AI_PROVIDER-с хамаарна
async function getAIReply(userMessage, history = []) {
  if (AI_PROVIDER === 'openai') return askOpenAI(userMessage, history);
  return askClaude(userMessage, history);
}

// ============================================================
//  1. WEBSITE WIDGET — /api/chat endpoint
// ============================================================

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'message шаардлагатай' });

    const reply = await getAIReply(message, history);
    res.json({ reply });
  } catch (err) {
    console.error('Website chat алдаа:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  2. FACEBOOK MESSENGER + INSTAGRAM DM
//     Meta Webhook: GET = verify, POST = мессеж хүлээн авах
// ============================================================

// Webhook баталгаажуулалт (нэг удаа, Meta developer console дотор)
app.get('/webhook/meta', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('Meta webhook баталгаажлаа');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Мессеж хүлээн авах
app.post('/webhook/meta', async (req, res) => {
  res.sendStatus(200); // Meta 20 секунд дотор хариу шаарддаг

  const body = req.body;
  if (body.object !== 'page' && body.object !== 'instagram') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      const text     = event.message?.text;

      if (!senderId || !text || event.message?.is_echo) continue;

      try {
        const reply = await getAIReply(text);
        await sendMetaMessage(senderId, reply);
      } catch (err) {
        console.error('Meta мессеж алдаа:', err.message);
      }
    }
  }
});

async function sendMetaMessage(recipientId, text) {
  await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${META_PAGE_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message:   { text },
    }),
  });
}

// ============================================================
//  3. WHATSAPP BUSINESS API
// ============================================================

app.get('/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('WhatsApp webhook баталгаажлаа');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);

  const entry   = req.body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (!message || message.type !== 'text') return;

  const from = message.from; // утасны дугаар
  const text = message.text?.body;
  if (!text) return;

  try {
    const reply = await getAIReply(text);
    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error('WhatsApp мессеж алдаа:', err.message);
  }
});

async function sendWhatsAppMessage(to, text) {
  await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
}

// ============================================================
//  СЕРВЕР ЭХЛҮҮЛЭХ
// ============================================================
app.listen(PORT, () => {
  console.log(`Сервер ажиллаж байна: http://localhost:${PORT}`);
  console.log(`AI provider: ${AI_PROVIDER}`);
});
