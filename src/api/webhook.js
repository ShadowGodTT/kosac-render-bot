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

const userSessions = {};  // Tracks current order session step
const userProfiles = {};  // Stores saved name, shop, address

app.use(express.json());

const getMatchingProducts = async (userMessage) => {
  const message = userMessage.toLowerCase();
  const keywords = message.split(" ").filter(Boolean);

  try {
    const response = await axios.get(`${SHOPIFY_STORE_URL}/admin/api/2023-01/products.json`, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
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

  const session = userSessions[phoneNumber] || {};
  const profile = userProfiles[phoneNumber];

  // 🟢 Greeting
  const greetings = ["hi", "hello", "hey", "namaste", "good morning", "good evening"];
  if (greetings.some(greet => userMessage.toLowerCase().includes(greet))) {
    const greetingReply = `👋 Hello! Welcome to *Kosac* – your eco-friendly packaging partner.\n\nYou can type things like:\n• kraft bags\n• silver container\n• paper bowls\n• paper cups\n• straws\n\nI'll help you find the right product instantly!`;

    await sendText(phoneNumber, greetingReply);
    return res.sendStatus(200);
  }

  // 🛒 Button tapped
  if (buttonId && buttonId.startsWith('order_')) {
    const handle = buttonId.replace('order_', '');
    userSessions[phoneNumber] = {
      step: 'awaiting_quantity',
      productHandle: handle
    };

    await sendText(phoneNumber, `How many kg or boxes of *${handle.replace(/-/g, ' ')}* would you like to order?`);
    return res.sendStatus(200);
  }

  // Step: quantity
  if (session.step === 'awaiting_quantity') {
    userSessions[phoneNumber].quantity = userMessage;

    if (userProfiles[phoneNumber]) {
      const p = userProfiles[phoneNumber];
      await sendText(phoneNumber,
        `You've previously ordered as *${p.name}* from *${p.shop}*, 📍 *${p.address}*.\nWould you like to use these saved details?\n\nReply:\n✅ Yes - to use same details\n✏️ Update - to enter new ones`);
      session.step = 'confirm_saved_info';
    } else {
      session.step = 'awaiting_name';
      await sendText(phoneNumber, `Please enter your full name:`);
    }

    return res.sendStatus(200);
  }

  // Step: use saved info or update
  if (session.step === 'confirm_saved_info') {
    const msg = userMessage.toLowerCase();
    if (msg.includes("yes")) {
      const { productHandle, quantity } = session;
      const { name, shop, address } = profile;

      await confirmOrder(phoneNumber, productHandle, quantity, name, shop, address);
      delete userSessions[phoneNumber];
      return res.sendStatus(200);
    } else {
      session.step = 'awaiting_name';
      await sendText(phoneNumber, `No problem! Please enter your full name:`);
      return res.sendStatus(200);
    }
  }

  // Step: name
  if (session.step === 'awaiting_name') {
    session.name = userMessage;
    session.step = 'awaiting_shop';
    await sendText(phoneNumber, `Thanks, ${userMessage}. Now please enter your *shop name*:`);
    return res.sendStatus(200);
  }

  // Step: shop
  if (session.step === 'awaiting_shop') {
    session.shop = userMessage;
    session.step = 'awaiting_address';
    await sendText(phoneNumber, `And finally, enter your *delivery address*:`);
    return res.sendStatus(200);
  }

  // Step: address + confirm order
  if (session.step === 'awaiting_address') {
    session.address = userMessage;
    const { productHandle, quantity, name, shop, address } = session;

    // Save profile
    userProfiles[phoneNumber] = { name, shop, address };

    await confirmOrder(phoneNumber, productHandle, quantity, name, shop, address);
    delete userSessions[phoneNumber];
    return res.sendStatus(200);
  }

  // Default: product search
  try {
    const matches = await getMatchingProducts(userMessage);
    if (matches.length > 0) {
      for (let p of matches.slice(0, 5)) {
        const isBoxUnit = /cup|straw/i.test(p.title);
        const unit = isBoxUnit ? "box" : "kg";

        await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
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
        }, {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
      }
      return res.sendStatus(200);
    } else {
      await sendText(phoneNumber, `❌ No matching product found for “${userMessage}”. Try something like "kraft bag", "paper bowl", or "container".`);
      return res.sendStatus(200);
    }
  } catch (error) {
    console.error('❌ WhatsApp send error:', error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

// Send plain text message
async function sendText(phone, text) {
  await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to: phone,
    text: { body: text }
  }, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// Confirm order
async function confirmOrder(phone, handle, quantity, name, shop, address) {
  const product = handle.replace(/-/g, ' ');
  const summary = `✅ Order Confirmed!\n\n🧾 Product: *${product}*\n📦 Qty: *${quantity}*\n👤 Name: *${name}*\n🏪 Shop: *${shop}*\n📍 Address: *${address}*`;

  await sendText(phone, summary);

  console.log("📝 ORDER:", {
    phone, product, quantity, name, shop, address
  });

  // TODO: Push to Google Sheet or Database if needed
}

// Meta webhook verification
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
