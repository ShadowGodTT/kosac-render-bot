const express = require('express');
const axios = require('axios');
const path = require('path');

// ✅ Load environment variables
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const port = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'kosac123';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;

app.use(express.json());

/**
 * 🔍 Match user message with live Shopify product list
 */
const getBestMatchProduct = async (userMessage) => {
  const message = userMessage.toLowerCase();

  try {
    const response = await axios.get(`${SHOPIFY_STORE_URL}/admin/api/2023-01/products.json`, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      }
    });

    const products = response.data.products;
    let bestMatch = null;
    let bestScore = 0;

    for (let product of products) {
      const title = product.title?.toLowerCase() || '';
      const desc = product.body_html?.toLowerCase() || '';

      // 🔹 Exact phrase match
      if (title.includes(message) || desc.includes(message)) {
        return {
          title: product.title,
          handle: product.handle,
          price: product.variants?.[0]?.price || "N/A"
        };
      }

      // 🔸 Partial keyword match
      const keywords = message.split(" ");
      const matchCount = keywords.filter(word => title.includes(word) || desc.includes(word)).length;

      if (matchCount > bestScore) {
        bestScore = matchCount;
        bestMatch = {
          title: product.title,
          handle: product.handle,
          price: product.variants?.[0]?.price || "N/A"
        };
      }
    }

    return bestMatch;
  } catch (err) {
    console.error("❌ Shopify fetch error:", err.response?.data || err.message);
    return null;
  }
};

/**
 * 📩 WhatsApp Webhook Handler
 */
app.post('/webhook', async (req, res) => {
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const phoneNumber = message?.from;
  const userMessage = message?.text?.body || '';

  if (!phoneNumber) return res.sendStatus(200);

  try {
    const match = await getBestMatchProduct(userMessage);

    const reply = match
      ? `🛍️ *${match.title}*\n💵 Price: ₹${match.price}\n🔗 View: https://kosac.in/products/${match.handle}`
      : `❌ Sorry, I couldn’t find a matching product for “${userMessage}”. Try using a more specific name.`;

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

    console.log('✅ Replied to:', phoneNumber, '| Product:', match?.title || 'No match');
  } catch (error) {
    console.error('❌ WhatsApp send error:', error.response?.data || error.message);
  }

  res.sendStatus(200);
});

/**
 * 🟢 Webhook verification (Meta setup)
 */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.listen(port, () => {
  console.log(`🚀 WhatsApp bot running at http://localhost:${port}`);
});
