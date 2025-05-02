
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
const RAZORPAY_API_KEY = process.env.RAZORPAY_API_KEY;
const RAZORPAY_API_SECRET = process.env.RAZORPAY_API_SECRET;

const userSessions = {};
const userProfiles = {};

app.use(express.json());

const getMatchingProducts = async (userMessage) => {
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/1uabyvJ3HzvgVt48wbbdn9uZrf_cGpEWB8o2hp2nteLM/export?format=csv';
  const keywords = userMessage.toLowerCase().split(" ").filter(Boolean);

  try {
    const response = await axios.get(sheetUrl);
    const lines = response.data.split('\n').slice(1);

    const products = lines.map(line => {
      const [name, variantTitle, sku, dimensions, quantity, price, imageUrl, handle] = line.split(',');
      return {
        name: name?.trim(),
        variantTitle: variantTitle?.trim(),
        price: parseFloat(price?.trim()),
        image: imageUrl?.trim(),
        handle: handle?.trim(),
        unit: /cup|straw/i.test(variantTitle || '') ? 'box' : 'kg'
      };
    }).filter(p => p.name && p.handle);

    const matched = products.filter(product =>
      keywords.some(k => product.variantTitle.toLowerCase().includes(k))
    );

    return matched;
  } catch (err) {
    console.error("❌ Failed to fetch sheet data:", err.message);
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
  const summary = `✅ Order Confirmed!\n\n🧾 Product: *${product}*\n📦 Quantity: *${quantity}*\n👤 Name: *${name}*\n🏪 Shop: *${shop}*\n📍 Address: *${address}*\n💳 Payment Method: *${paymentMethod}*`;

  await sendText(phone, summary);

  userProfiles[phone] = {
    ...userProfiles[phone],
    name, shop, address, productHandle: handle, quantity
  };

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
    await sendText(phone, `Please enter the quantity (in kg or boxes) for *${handle.replace(/-/g, ' ')}*:`);  
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_quantity') {
    session.quantity = userMessage;
    if (profile) {
      await sendButtons(phone, `Previously saved details:\n👤 *${profile.name}*\n🏪 *${profile.shop}*\n📍 *${profile.address}*\nWould you like to continue with these?`, [
        { type: 'reply', reply: { id: 'use_saved', title: '✅ Use Same' } },
        { type: 'reply', reply: { id: 'update_info', title: '✏️ Update Info' } }
      ]);
      session.step = 'confirm_saved_info';
    } else {
      session.step = 'awaiting_name';
      await sendText(phone, `Let's proceed. Please enter your full name:`);
    }
    return res.sendStatus(200);
  }

  if (buttonId === 'use_saved') {
    session.name = profile.name;
    session.shop = profile.shop;
    session.address = profile.address;
    session.step = 'awaiting_payment_method';
    await sendButtons(phone, `Select your preferred payment method:`, [
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
    await sendText(phone, `Great. Lastly, please provide your delivery address:`);
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
    await sendButtons(phone, `Select your preferred payment method:`, [
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
    const amount = parseFloat(session.quantity) * 10;
    const order = await createRazorpayOrder(amount, uuidv4());
    const paymentLink = `https://rzp.io/i/${order.id}`;
    await sendText(phone, `💳 Please complete your payment using the link below:\n${paymentLink}\n\nOnce payment is done, our team will proceed with delivery.`);
    await confirmOrder(phone, session.productHandle, session.quantity, session.name, session.shop, session.address, 'Online (UPI)');
    delete userSessions[phone];
    return res.sendStatus(200);
  }

  const greetings = ["hi", "hello", "hey", "namaste"];
  if (greetings.some(g => userMessage.toLowerCase().includes(g))) {
    await sendText(phone, `👋 Welcome to *Kosac* – your eco-friendly packaging partner!\n\nType a product name to view options.\nFor example:\n• kraft bag 5kg\n• cup 250ml\n• paper straw`);
    return res.sendStatus(200);
  }

  const matches = await getMatchingProducts(userMessage);
  if (matches.length > 0) {
    for (let p of matches.slice(0, 5)) {
      const priceUnit = p.unit;
      const caption = `🛍️ *${p.variantTitle}*\n💰 ₹${p.price}/${priceUnit}\n📦 Available Now!\n\n👇 Tap below to order`;

      // 1. Image
      await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'image',
        image: { link: p.image }
      }, {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });

      // 2. Text + Button
      await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: caption },
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
    await sendText(phone, `❌ Sorry, no matching products found. Try another product name.`);
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
  console.log(`🚀 Kosac WhatsApp bot live on port ${port}`);
});
