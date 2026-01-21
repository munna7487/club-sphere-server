const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECREATE);
const admin = require("firebase-admin");

const serviceAccount = require("./club-sphere-11e4b-firebase-adminsdk-fbsvc-863ee592e2.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const port = process.env.PORT || 3000;

// ================= Tracking ID =================
function generateTrackingId(prefix = "TRK") {
  return `${prefix}-${Date.now()}`;
}

// ================= Middleware =================
app.use(express.json());
app.use(cors());

// ================= Firebase Authorization Middleware =================
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: 'Unauthorized access: No token provided' });
  }

  try {
    const idToken = token.split(' ')[1]; // "Bearer <token>"
    const decoded = await admin.auth().verifyIdToken(idToken);

    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    console.error('Firebase token verification error:', err);
    return res.status(401).send({ message: 'Unauthorized access: Invalid token' });
  }
};

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
  console.log("✅ MongoDB connected");

  const db = client.db('slubsphere');
  const clubcollection = db.collection('clubs');
  const paymentcollection = db.collection('payments');
  const usercollection = db.collection('users');

  // ================= Admin Middleware =================
  const verifyAdmin = async (req, res, next) => {
    const email = req.decoded_email;
    const user = await usercollection.findOne({ email });

    if (!user || user.role !== 'admin') {
      return res.status(403).send({ message: 'Forbidden: Admin only' });
    }
    next();
  };

  // ================= USERS API =================
  app.post('/users', async (req, res) => {
    const user = req.body;

    // duplicate email check
    const existingUser = await usercollection.findOne({ email: user.email });
    if (existingUser) {
      return res.send({ message: 'user already exists' });
    }

    user.role = 'user';
    user.createdAt = new Date();

    const result = await usercollection.insertOne(user);
    res.send(result);
  });

  // USERS GET (admin only)
  app.get('/users', verifyFBToken, verifyAdmin, async (req, res) => {
    const cursor = usercollection.find();
    const result = await cursor.toArray();
    res.send(result);
  });

  // USERS PATCH (admin only)
  
  app.patch('/users/:id', verifyFBToken, verifyAdmin, async (req, res) => {
  const id = req.params.id;
  const { role } = req.body;

  // only allow these roles
  const allowedRoles = ['user', 'manager', 'admin'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).send({ message: 'Invalid role' });
  }

  const result = await usercollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { role } }
  );

  res.send(result);
});


  // GET USER ROLE
  app.get('/users/:email/role', async (req, res) => {
    const email = req.params.email;
    const query = { email };
    const user = await usercollection.findOne(query);
    res.send({ role: user?.role || 'user' });
  });

  // ================= CLUBS API =================
  app.get('/clubs', async (req, res) => {
    const email = req.query.email;
    const query = email ? { createremail: email } : {};
    const result = await clubcollection.find(query).toArray();
    res.send(result);
  });

  app.get('/clubs/:id', async (req, res) => {
    const result = await clubcollection.findOne({ _id: new ObjectId(req.params.id) });
    res.send(result);
  });

  app.post('/clubs', verifyFBToken, async (req, res) => {
    const clubData = req.body;

    if (!clubData.clubName || !clubData.createremail) {
      return res.status(400).send({ message: 'Club name or creator email missing' });
    }

    if (clubData.createremail !== req.decoded_email) {
      return res.status(403).send({ message: 'Forbidden: Email mismatch' });
    }

    try {
      const result = await clubcollection.insertOne({
        ...clubData,
        createdAt: new Date(),
        paymentStatus: 'pending',
      });

      res.send({
        success: true,
        clubId: result.insertedId,
        message: 'Club created successfully',
      });
    } catch (err) {
      console.error('Error creating club:', err);
      res.status(500).send({ message: 'Internal server error' });
    }
  });

  // ================= STRIPE CHECKOUT =================
  app.post('/create-checkout-session', async (req, res) => {
    const info = req.body;

    if (!info.membershipFee) {
      return res.status(400).send({ error: 'Membership fee missing' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: info.createremail,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: Number(info.membershipFee) * 100,
            product_data: {
              name: info.clubName,
            },
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      metadata: {
        clubId: info._id,
        clubName: info.clubName,
      },
      success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    });

    res.send({ url: session.url });
  });

  // ================= PAYMENT SUCCESS =================
  app.patch('/payment-success', async (req, res) => {
    const sessionId = req.query.session_id;

    if (!sessionId) {
      return res.status(400).send({ error: 'session_id missing' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(400).send({ error: 'Payment not completed' });
    }

    const clubId = session.metadata.clubId;
    const transactionId = session.payment_intent;

    const existingPayment = await paymentcollection.findOne({ transactionid: transactionId });

    if (existingPayment) {
      return res.send({ success: true, paymentinfo: existingPayment });
    }

    await clubcollection.updateOne(
      { _id: new ObjectId(clubId) },
      { $set: { paymentStatus: 'paid', trackingid: generateTrackingId() } }
    );

    const payment = {
      amount: session.amount_total / 100,
      currency: session.currency,
      customeremail: session.customer_details?.email || '',
      userid: clubId,
      clubname: session.metadata.clubName,
      transactionid: transactionId,
      paymentstatus: session.payment_status,
      paidAt: new Date(),
    };

    await paymentcollection.insertOne(payment);

    res.send({ success: true, paymentinfo: payment });
  });

  //start

// GET paid clubs (admin only)
app.get('/admin/paid-clubs', verifyFBToken, verifyAdmin, async (req, res) => {
  const result = await clubcollection.find({ paymentStatus: 'paid' }).toArray();
  res.send(result);
});
// APPROVE club (admin only)
app.patch('/admin/clubs/approve/:id', verifyFBToken, verifyAdmin, async (req, res) => {
  const id = req.params.id;

  const result = await clubcollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'approved' } }
  );

  res.send(result);
});
// REJECT club (admin only)
app.delete('/admin/clubs/reject/:id', verifyFBToken, verifyAdmin, async (req, res) => {
  const id = req.params.id;

  const result = await clubcollection.deleteOne({ _id: new ObjectId(id) });
  res.send(result);
});


// ================= APPROVED CLUBS (USER SIDE) =================
app.get('/approved-clubs', async (req, res) => {
  const result = await clubcollection
    .find({ status: 'approved' })
    .sort({ createdAt: -1 })
    .toArray();

  res.send(result);
});


  //end

  // ================= PAYMENT HISTORY =================
  app.get('/payments', verifyFBToken, async (req, res) => {
    const email = req.query.email;

    if (!email) return res.status(400).send({ message: 'Email query missing' });
    if (email !== req.decoded_email) return res.status(403).send({ message: 'Forbidden access' });

    const clubs = await clubcollection.find({ createremail: email }).toArray();
    const clubIds = clubs.map(club => club._id.toString());

    const payments = await paymentcollection.find({ userid: { $in: clubIds } }).sort({ paidAt: -1 }).toArray();
    res.send(payments);
  });
}

run().catch(console.dir);

// ================= ROOT =================
app.get('/', (req, res) => {
  res.send('🚀 Server running');
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
