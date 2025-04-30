const express = require('express');
const axios = require('axios');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const port = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'kosac123';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;

const userSessions = {}; // temporary in-memory session store

app.use(express.json());

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
        return keywords.some(word => title.includes(word));
      })
      .map(product => ({
        title: product.title,
        handle: product.handle,
        price: product.variants?.[0]?.price || "N/A"
      }));

    return matchedProducts;
  } catch (err) {
    console.error("❌ Shopify fetch error:", err.response?.data || err.message);
    return [];
  }
};

app.post('/webhook', async (req, res) => {
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const phoneNumber = message?.from;
  const userMessage = message?.text?.body || '';
  const buttonId = message?.interactive?.button_reply?.id;

  if (!phoneNumber) return res.sendStatus(200);

  // 🟢 Greeting
  const greetings = ["hi", "hello", "hey", "namaste", "good morning", "good evening"];
  if (greetings.some(greet => userMessage.toLowerCase().includes(greet))) {
    const greetingReply = `👋 Hello! Welcome to *Kosac* – your eco-friendly packaging partner.\n\nYou can type things like:\n• kraft bags\n• silver container\n• paper bowls\n• paper cups\n• straws\n\nI'll help you find the right product instantly!`;

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

  // 🛒 Button tapped: "Order This"
  if (buttonId && buttonId.startsWith('order_')) {
    const handle = buttonId.replace('order_', '');

    userSessions[phoneNumber] = {
      step: 'awaiting_quantity',
      productHandle: handle
    };

    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      text: {
        body: `How many kg or boxes of *${handle.replace(/-/g, ' ')}* would you like to order?`
      }
    }, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    return res.sendStatus(200);
  }

  // 🧮 Quantity response
  if (userSessions[phoneNumber]?.step === 'awaiting_quantity') {
    userSessions[phoneNumber].quantity = userMessage;
    userSessions[phoneNumber].step = 'awaiting_address';

    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      text: {
        body: `Got it! Now please share your delivery address.`
      }
    }, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    return res.sendStatus(200);
  }

  // 📍 Address response + order confirmation
  if (userSessions[phoneNumber]?.step === 'awaiting_address') {
    userSessions[phoneNumber].address = userMessage;
    const { productHandle, quantity, address } = userSessions[phoneNumber];

    const productName = productHandle.replace(/-/g, ' ');

    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      text: {
        body: `✅ Your order for *${quantity}* of *${productName}* has been placed!\n📍 Address: ${address}\n\nOur team will contact you soon. Thank you! 🙏`
      }
    }, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    // Optionally log or forward to your team here
    console.log("📝 NEW ORDER:", {
      phone: phoneNumber,
      product: productName,
      quantity,
      address
    });

    delete userSessions[phoneNumber];

    return res.sendStatus(200);
  }

  // 🔍 Search products if not in a session
  try {
    const matches = await getMatchingProducts(userMessage);

    if (matches.length > 0) {
      for (let p of matches.slice(0, 5)) {
        const isBoxUnit = /cup|straw/i.test(p.title);
        const unit = isBoxUnit ? "box" : "kg";

        const buttonPayload = {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: {
              text: `🛍️ *${p.title}*\n💵 ₹${p.price}/${unit}\n🔗 https://kosac.in/products/${p.handle}`
            },
            action: {
              buttons: [
                {
                  type: 'reply',
                  reply: {
                    id: `order_${p.handle}`,
                    title: '🛒 Order This'
                  }
                }
              ]
            }
          }
        };

        await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, buttonPayload, {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
      }

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

// 🔐 Meta webhook verification
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
