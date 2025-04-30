// AI-based product search version
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ✅ Load .env from root even when running from /src/api
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const port = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'kosac123';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY. Please check your .env file.");
  process.exit(1); // Stop the server if key is missing
}

const productData = require(path.join(__dirname, 'product-data.json'));
const productEmbeddings = require(path.join(__dirname, 'product-embeddings.json'));

app.use(express.json());

// 🔢 Cosine similarity
const cosineSimilarity = (vecA, vecB) => {
  const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
};

// 🧠 Generate embedding from OpenAI
const getEmbedding = async (text) => {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/embeddings',
      {
        input: text,
        model: 'text-embedding-ada-002'
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data.data[0].embedding;
  } catch (err) {
    console.error("❌ Error getting embedding:", err.response?.data || err.message);
    return null;
  }
};

// 🔍 Find best match
const getBestMatchProduct = async (message) => {
  const inputEmbedding = await getEmbedding(message);
  if (!inputEmbedding) return null;

  let bestMatch = null;
  let bestScore = -1;

  for (let i = 0; i < productEmbeddings.length; i++) {
    const score = cosineSimilarity(inputEmbedding, productEmbeddings[i].embedding);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = productData[i];
    }
  }

  return bestMatch;
};

// 📩 WhatsApp Webhook
app.post('/webhook', async (req, res) => {
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const phoneNumber = message?.from;
  const userMessage = message?.text?.body || '';

  if (!phoneNumber) return res.sendStatus(200);

  try {
    const match = await getBestMatchProduct(userMessage);

    const reply = match
      ? `🛍️ ${match.title}\n💵 Price: ₹${match.price}\n🔗 View More: https://kosac.in/products/${match.handle}`
      : `❌ Sorry, I couldn’t find a matching product for “${userMessage}”. Please try another name or send a photo.`;

    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      text: { body: reply }
    }, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Message sent to', phoneNumber, '| Match:', match?.title || 'No match');
  } catch (error) {
    console.error('❌ AI search error:', error.response?.data || error.message);
  }

  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
