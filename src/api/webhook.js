const express = require('express');
const axios = require('axios');
const path = require('path');

// ✅ Load environment variables from root .env
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
 * 🧠 Get loosely matching products from Shopify
 */
const getMatchingProducts = async (userMessage) => {
  const message = userMessage.toLowerCase();
  const keywords = message.split(" ").filter(Boolean);

  try {
    const response = await axios.get(`${SHOPIFY_STORE_URL}/admin/api/2023-01/products.json`, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      }
    });

    const products = response.data.products;

    const matchedProducts = products
      .filter(product => {
        const title = product.title?.toLowerCase() || '';
        const desc = product.body_html?.toLowerCase() || '';

        // Match if any keyword exists in title or description
        return keywords.some(word =>
          title.includes(word) || desc.includes(word)
        );
      })
      .map(product => ({
        title: product.title,
        handle: product.handle,
        price: product.variants?.[0]?.price || "N/A"
      }));

    console.log("✅ Matching products found:", matchedProducts.length);
    return matchedProducts;
  } catch (err) {
    console.error("❌ Shopify fetch error:", err.response?.data || err.message);
    return [];
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

  // 🟢 Greeting Handler
  const greetings = ["hi", "hello", "hey", "namaste", "good morning", "good evening"];
  if (greetings.some(greet => userMessage.toLowerCase().includes(greet))) {
    const greetingReply = `👋 Hello! Welcome to *Kosac* – your eco-friendly packaging partner.\n\nYou can type things like:\n• kraft bags\n• silver container\n• paper bowls\n\nI'll help you find the right product instantly!`;

    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      text: { body: greetingReply }
    }, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    return res.sendStatus(200);
  }

  // 🔍 Search for matching products
  try {
    const matches = await getMatchingProducts(userMessage);

    if (matches.length > 0) {
      let reply = `Here are some products matching “${userMessage}”:\n\n`;

      matches.slice(0, 5).forEach((p, index) => {
        reply += `${index + 1}️⃣ *${p.title}* – ₹${p.price}/kg\n🔗 https://kosac.in/products/${p.handle}\n\n`;
      });

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

      return res.sendStatus(200);
    } else {
      const notFound = `❌ Sorry, I couldn’t find any matching product for “${userMessage}”. Try something like "kraft bag", "paper bowl", or "container".`;

      await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        text: { body: notFound }
      }, {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });

      return res.sendStatus(200);
    }
  } catch (error) {
    console.error('❌ WhatsApp send error:', error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

/**
 * 🟢 Webhook verification for Meta setup
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
