const express = require('express');
const axios = require('axios');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const port = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'kosac123';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const RAZORPAY_API_KEY = process.env.RAZORPAY_API_KEY;
const RAZORPAY_API_SECRET = process.env.RAZORPAY_API_SECRET;

const userSessions = {};
const userProfiles = {};

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

const sendText = async (phone, text) => {
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
};

const sendButtons = async (phone, text, buttons) => {
  await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: { buttons }
    }
  }, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
};

const createRazorpayOrder = async (amount, receipt) => {
  const auth = Buffer.from(`${RAZORPAY_API_KEY}:${RAZORPAY_API_SECRET}`).toString('base64');
  const response = await axios.post('https://api.razorpay.com/v1/orders', {
    amount: amount * 100,
    currency: 'INR',
    receipt,
    payment_capture: 1
  }, {
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  });
  return response.data;
};

const confirmOrder = async (phone, handle, quantity, name, shop, address, paymentMethod) => {
  const product = handle.replace(/-/g, ' ');
  const summary = `✅ Order Confirmed!

🧾 Product: *${product}*
📦 Qty: *${quantity}*
👤 Name: *${name}*
🏪 Shop: *${shop}*
📍 Address: *${address}*
💳 Payment: *${paymentMethod}*`;
  await sendText(phone, summary);
  console.log("📝 ORDER:", { phone, product, quantity, name, shop, address, paymentMethod });
};

app.post('/webhook', async (req, res) => {
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const phone = message?.from;
  const userMessage = message?.text?.body || '';
  const buttonId = message?.interactive?.button_reply?.id;

  if (!phone) return res.sendStatus(200);
  const session = userSessions[phone] || {};
  const profile = userProfiles[phone];

  if (buttonId?.startsWith('order_')) {
    const handle = buttonId.replace('order_', '');
    userSessions[phone] = { step: 'awaiting_quantity', productHandle: handle };
    await sendText(phone, `How many kg or boxes of *${handle.replace(/-/g, ' ')}* would you like to order?`);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_quantity') {
    userSessions[phone].quantity = userMessage;
    if (profile) {
      await sendButtons(phone, `You've ordered as *${profile.name}* from *${profile.shop}* 📍 *${profile.address}*.
Use these details?`, [
        { type: 'reply', reply: { id: 'use_saved', title: '✅ Yes' } },
        { type: 'reply', reply: { id: 'update_info', title: '✏️ Update' } }
      ]);
      session.step = 'confirm_saved_info';
    } else {
      session.step = 'awaiting_name';
      await sendText(phone, `Please enter your full name:`);
    }
    return res.sendStatus(200);
  }

  if (buttonId === 'use_saved') {
    session.name = profile.name;
    session.shop = profile.shop;
    session.address = profile.address;
    session.step = 'awaiting_payment_method';
    await sendButtons(phone, `How would you like to pay?`, [
      { type: 'reply', reply: { id: 'pay_cod', title: '💸 Cash on Delivery' } },
      { type: 'reply', reply: { id: 'pay_online', title: '💳 Online (UPI)' } }
    ]);
    return res.sendStatus(200);
  }

  if (buttonId === 'update_info' || session.step === 'awaiting_name') {
    session.name = userMessage;
    session.step = 'awaiting_shop';
    await sendText(phone, `Thanks, ${userMessage}. Now enter your shop name:`);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_shop') {
    session.shop = userMessage;
    session.step = 'awaiting_address';
    await sendText(phone, `Great! Now share your delivery address:`);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_address') {
    session.address = userMessage;
    userProfiles[phone] = {
      name: session.name,
      shop: session.shop,
      address: session.address
    };
    session.step = 'awaiting_payment_method';
    await sendButtons(phone, `How would you like to pay?`, [
      { type: 'reply', reply: { id: 'pay_cod', title: '💸 Cash on Delivery' } },
      { type: 'reply', reply: { id: 'pay_online', title: '💳 Online (UPI)' } }
    ]);
    return res.sendStatus(200);
  }

  if (buttonId === 'pay_cod') {
    await confirmOrder(phone, session.productHandle, session.quantity, session.name, session.shop, session.address, 'Cash on Delivery');
    delete userSessions[phone];
    return res.sendStatus(200);
  }

  if (buttonId === 'pay_online') {
    const amount = parseFloat(session.quantity) * 10; // adjust pricing logic
    const order = await createRazorpayOrder(amount, uuidv4());
    const paymentLink = `https://rzp.io/i/${order.id}`; // optional: real payment link
    await sendText(phone, `💳 Please complete your payment here:
${paymentLink}

Once done, our team will contact you to confirm delivery.`);
    await confirmOrder(phone, session.productHandle, session.quantity, session.name, session.shop, session.address, 'Online Payment (UPI)');
    delete userSessions[phone];
    return res.sendStatus(200);
  }

  const greetings = ["hi", "hello", "hey", "namaste"];
  if (greetings.some(g => userMessage.toLowerCase().includes(g))) {
    await sendText(phone, `👋 Hello! Welcome to *Kosac* – your eco-friendly packaging partner. Type product names like "kraft bags" or "silver container" to start ordering.`);
    return res.sendStatus(200);
  }

  const matches = await getMatchingProducts(userMessage);
  if (matches.length > 0) {
    for (let p of matches.slice(0, 5)) {
      const isBoxUnit = /cup|straw/i.test(p.title);
      const unit = isBoxUnit ? "box" : "kg";
      await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: `🛍️ *${p.title}*\n💵 ₹${p.price}/${unit}\n🔗 https://kosac.in/products/${p.handle}` },
          action: {
            buttons: [
              { type: 'reply', reply: { id: `order_${p.handle}`, title: '🛒 Order This' } }
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
    await sendText(phone, `❌ Sorry, no products found. Try again.`);
    return res.sendStatus(200);
  }
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.listen(port, () => {
  console.log(`🚀 WhatsApp bot running on port ${port}`);
});
