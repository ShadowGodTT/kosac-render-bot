
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

const bagVariants = ["3 x 5", "4 x 6", "5 x 7", "6 x 8", "7 x 9", "8 x 10"];
const bagImage = "https://kosac.in/cdn/shop/files/bag_common_image.jpg"; // Update this if needed

const sendText = async (phone, text) => {
  await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to: phone,
    text: { body: text.slice(0, 1024) }
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
      body: { text: text.slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map(btn => ({
          type: 'reply',
          reply: {
            id: btn.reply.id,
            title: btn.reply.title.slice(0, 20)
          }
        }))
      }
    }
  }, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
};

const sendImage = async (phone, imageUrl) => {
  await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'image',
    image: { link: imageUrl }
  }, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
};

app.post('/webhook', async (req, res) => {
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const phone = message?.from;
  const userMessage = message?.text?.body || '';
  const buttonId = message?.interactive?.button_reply?.id;

  if (!phone) return res.sendStatus(200);
  const session = userSessions[phone] || { selectedVariants: [] };

  const greetings = ["hi", "hello", "hey", "namaste"];
  if (greetings.some(g => userMessage.toLowerCase().includes(g))) {
    await sendButtons(phone, `👋 Welcome to *Kosac*!
Choose a product type:`, [
      { type: 'reply', reply: { id: 'select_bags', title: '👜 Kraft Bags' } },
      { type: 'reply', reply: { id: 'select_cups', title: '🥤 Cups' } },
      { type: 'reply', reply: { id: 'select_more', title: '➕ View More' } }
    ]);
    return res.sendStatus(200);
  }

  if (buttonId === 'select_bags') {
    session.step = 'awaiting_bag_variant';
    session.selectedVariants = [];
    userSessions[phone] = session;

    await sendImage(phone, bagImage);
    await sendButtons(phone, `Choose bag sizes:`, bagVariants.slice(0, 3).map((v, i) => ({
      type: 'reply',
      reply: { id: `bag_variant_${i}`, title: v }
    })));
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_bag_variant' && buttonId?.startsWith('bag_variant_')) {
    const index = parseInt(buttonId.split('_')[2]);
    const variant = bagVariants[index];
    if (!session.selectedVariants.includes(variant)) {
      session.selectedVariants.push(variant);
    }

    const nextIndex = session.selectedVariants.length + 3;
    if (nextIndex < bagVariants.length) {
      await sendButtons(phone, `Select more or type 'done':`, bagVariants.slice(nextIndex, nextIndex + 3).map((v, i) => ({
        type: 'reply',
        reply: { id: `bag_variant_${nextIndex + i}`, title: v }
      })));
    } else {
      await sendText(phone, `Selected: ${session.selectedVariants.join(', ')}
Type 'done' to continue.`);
    }

    userSessions[phone] = session;
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_bag_variant' && userMessage.toLowerCase() === 'done') {
    session.step = 'awaiting_quantity';
    await sendText(phone, `Enter quantity (e.g. 3kg for 3x5, 5kg for 4x6):`);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_quantity') {
    session.quantityNote = userMessage;
    session.step = 'awaiting_name';
    await sendText(phone, `Your name please:`);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_name') {
    session.name = userMessage;
    session.step = 'awaiting_shop';
    await sendText(phone, `Shop name:`);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_shop') {
    session.shop = userMessage;
    session.step = 'awaiting_address';
    await sendText(phone, `Delivery address:`);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_address') {
    session.address = userMessage;
    session.step = 'awaiting_payment';
    await sendButtons(phone, `Payment method:`, [
      { type: 'reply', reply: { id: 'pay_cod', title: '💸 COD' } },
      { type: 'reply', reply: { id: 'pay_online', title: '💳 UPI' } }
    ]);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_payment') {
    const method = buttonId === 'pay_online' ? 'Online (UPI)' : 'Cash on Delivery';
    await sendText(phone, `✅ Order Confirmed!

👜 ${session.selectedVariants.join(', ')}
📦 ${session.quantityNote}
👤 ${session.name}
🏪 ${session.shop}
📍 ${session.address}
💳 ${method}`);
    delete userSessions[phone];
    return res.sendStatus(200);
  }

  return res.sendStatus(200);
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
