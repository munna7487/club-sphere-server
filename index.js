// index.js
const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECREATE);

const port = process.env.PORT || 3000;

// ================= Tracking ID generator =================
function generateTrackingId(prefix = "TRK") {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = Math.floor(100000 + Math.random() * 900000);
  return `${prefix}-${date}-${random}`;
}

// ================= Middleware =================
app.use(express.json());
app.use(cors());

// ================= MongoDB =================
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.m5aqddh.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  await client.connect();
  console.log("MongoDB connected");

  const db = client.db('slubsphere');
  const clubcollection = db.collection('clubs');
  const paymentcollection = db.collection('payments');

  // ================= GET CLUBS =================
  app.get('/clubs', async (req, res) => {
    const email = req.query.email;
    const query = email ? { createremail: email } : {};
    const result = await clubcollection.find(query).toArray();
    res.send(result);
  });

  // ================= CREATE CLUB =================
  app.post('/clubs', async (req, res) => {
    const club = req.body;
    const newClub = {
      ...club,
      paymentStatus: 'pay',
      createdAt: new Date(),
    };
    const result = await clubcollection.insertOne(newClub);
    res.send(result);
  });

  // ================= GET SINGLE CLUB =================
  app.get('/clubs/:id', async (req, res) => {
    const result = await clubcollection.findOne({
      _id: new ObjectId(req.params.id),
    });
    res.send(result);
  });

  // ================= DELETE CLUB =================
  app.delete('/clubs/:id', async (req, res) => {
    const result = await clubcollection.deleteOne({
      _id: new ObjectId(req.params.id),
    });
    res.send(result);
  });

  // ================= STRIPE CHECKOUT =================
  app.post('/create-checkout-session', async (req, res) => {
    const paymentinfo = req.body;
    const amount = Number(paymentinfo.membershipFee) * 100;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: amount,
            product_data: {
              name: paymentinfo.clubName,
            },
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      metadata: {
        clubId: paymentinfo._id,
        clubName: paymentinfo.clubName,
      },
      success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    });

    res.send({ url: session.url });
  });

  // ================= PAYMENT SUCCESS =================
  app.patch('/payment-success', async (req, res) => {
    const session_id = req.query.session_id;

    if (!session_id)
      return res.status(400).send({ error: 'session_id missing' });

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid')
      return res.status(400).send({ error: 'Payment not completed' });

    const clubId = session.metadata.clubId;

    // update club payment status + tracking id
    await clubcollection.updateOne(
      { _id: new ObjectId(clubId) },
      {
        $set: {
          paymentStatus: 'paid',
          trackingid: generateTrackingId(),
        },
      }
    );

    // payment record
    const payment = {
      amount: session.amount_total / 100,
      currency: session.currency,
      customeremail: session.customer_details?.email || '',
      userid: clubId,
      clubname: session.metadata.clubName || '',
      transactionid: session.payment_intent,
      paymentstatus: session.payment_status,
      paidAt: new Date(),
    };

    // insert payment
    await paymentcollection.insertOne(payment);

    // send inserted document to frontend
    res.send({ success: true, paymentinfo: payment });
  });
}

run().catch(console.dir);

// ================= ROOT =================
app.get('/', (req, res) => {
  res.send('Server running');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
