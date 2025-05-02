
// NOTE: This is a base scaffold. It includes:
// 1. Greeting with 3 buttons (Kraft Bags, Paper Cups, View More)
// 2. Clicking "Brown Kraft Paper Bags" shows image + variant buttons
// 3. User can select multiple variants, then order proceeds.

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

const bagVariants = [
  "3 x 5", "4 x 6", "5 x 7", "6 x 8", "7 x 9", "8 x 10"
];

const bagImage = "https://kosac.in/cdn/shop/files/bag_common_image.jpg"; // Replace with actual image link

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

  // Greeting
  const greetings = ["hi", "hello", "hey", "namaste"];
  if (greetings.some(g => userMessage.toLowerCase().includes(g))) {
    await sendButtons(phone, `👋 Welcome to *Kosac* – your eco-friendly packaging partner!

What are you looking for today?`, [
      { type: 'reply', reply: { id: 'select_bags', title: '👜 Brown Kraft Paper Bags' } },
      { type: 'reply', reply: { id: 'select_cups', title: '🥤 Paper Cups' } },
      { type: 'reply', reply: { id: 'select_more', title: '➕ View More' } }
    ]);
    return res.sendStatus(200);
  }

  // On Kraft Paper Bags click
  if (buttonId === 'select_bags') {
    session.step = 'awaiting_bag_variant';
    session.selectedVariants = [];
    userSessions[phone] = session;

    await sendImage(phone, bagImage);
    await sendButtons(phone, `Choose the sizes you want to order (tap multiple one by one):`, 
      bagVariants.slice(0, 3).map((v, i) => ({
        type: 'reply',
        reply: { id: `bag_variant_${i}`, title: v }
      }))
    );
    return res.sendStatus(200);
  }

  // Handle variant selections
  if (session.step === 'awaiting_bag_variant' && buttonId?.startsWith('bag_variant_')) {
    const index = parseInt(buttonId.split('_')[2]);
    const variant = bagVariants[index];
    if (!session.selectedVariants.includes(variant)) {
      session.selectedVariants.push(variant);
    }

    // If not all variants shown yet, show next batch
    const shownCount = session.selectedVariants.length + 3;
    if (shownCount < bagVariants.length) {
      await sendButtons(phone, `Select more or type 'done' when ready:`, 
        bagVariants.slice(shownCount, shownCount + 3).map((v, i) => ({
          type: 'reply',
          reply: { id: `bag_variant_${shownCount + i}`, title: v }
        }))
      );
    } else {
      await sendText(phone, `You've selected: ${session.selectedVariants.join(', ')}

Please type 'done' to proceed.`);
    }

    userSessions[phone] = session;
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_bag_variant' && userMessage.toLowerCase() === 'done') {
    session.step = 'awaiting_quantity';
    await sendText(phone, `Great. Now enter the quantity (e.g., "3kg for 3x5, 5kg for 4x6")`);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_quantity') {
    session.quantityNote = userMessage;
    session.step = 'awaiting_name';
    await sendText(phone, `Please enter your full name:`);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_name') {
    session.name = userMessage;
    session.step = 'awaiting_shop';
    await sendText(phone, `Thanks. Now enter your shop name:`);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_shop') {
    session.shop = userMessage;
    session.step = 'awaiting_address';
    await sendText(phone, `Almost done. Enter your delivery address:`);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_address') {
    session.address = userMessage;
    session.step = 'awaiting_payment';
    await sendButtons(phone, `Choose payment method:`, [
      { type: 'reply', reply: { id: 'pay_cod', title: '💸 Cash on Delivery' } },
      { type: 'reply', reply: { id: 'pay_online', title: '💳 Pay Online' } }
    ]);
    return res.sendStatus(200);
  }

  if (session.step === 'awaiting_payment') {
    const paymentMethod = buttonId === 'pay_cod' ? 'Cash on Delivery' : 'Online';
    await sendText(phone, `✅ Order Confirmed!

👜 Variants: *${session.selectedVariants.join(', ')}*
📦 Quantity: *${session.quantityNote}*
👤 Name: *${session.name}*
🏪 Shop: *${session.shop}*
📍 Address: *${session.address}*
💳 Payment: *${paymentMethod}*`);
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
  console.log(`🚀 Kosac WhatsApp bot with multi-variant flow live on port ${port}`);
});
