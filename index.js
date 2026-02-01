const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECREATE);
const admin = require("firebase-admin");

// Decode Firebase service account from base64 stored in .env
let serviceAccount;
try {
  if (!process.env.FB_SERVICE_KEY) {
    throw new Error("FB_SERVICE_KEY is missing in environment variables");
  }
  const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8');
  serviceAccount = JSON.parse(decodedKey);
} catch (err) {
  console.error("❌ Failed to parse Firebase service key:", err);
  process.exit(1); // Stop server if Firebase cannot initialize
}

// Initialize Firebase admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
console.log("✅ Firebase admin initialized");

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
  // await client.connect();
  console.log("✅ MongoDB connected");
  const db = client.db('slubsphere');
  const clubcollection = db.collection('clubs');
  const paymentcollection = db.collection('payments');
  const usercollection = db.collection('users');
  const eventcollection = db.collection('events');
  const eventRegisterCollection = db.collection('eventRegisters');

  // ================= Admin Middleware =================
  const verifyAdmin = async (req, res, next) => {
    const email = req.decoded_email;
    const user = await usercollection.findOne({ email });
    if (!user || user.role !== 'admin') {
      return res.status(403).send({ message: 'Forbidden: Admin only' });
    }
    next();
  };

  // ================= GET EVENTS BY CLUB =================
  app.get('/clubs/:id/events', async (req, res) => {
    const clubId = req.params.id;
    try {
      const events = await eventcollection
        .find({ clubId: new ObjectId(clubId), status: 'upcoming' })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(events);
    } catch (error) {
      console.error('Error fetching club events:', error);
      res.status(500).send({ message: 'Server error' });
    }
  });

  // ================= GET EVENTS (WITH SEARCH) =================
  app.get('/events', async (req, res) => {
    try {
      const search = req.query.search || '';
      const query = {
        status: 'upcoming',
        title: { $regex: search, $options: 'i' }
      };
      const events = await eventcollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(events);
    } catch (error) {
      console.error('Events fetch error:', error);
      res.status(500).send({ message: 'Server error' });
    }
  });

  // ================= REGISTER EVENT =================
  app.post('/event-register', verifyFBToken, async (req, res) => {
    const { eventId, eventTitle } = req.body;
    const email = req.decoded_email;
    // duplicate check
    const alreadyRegistered = await eventRegisterCollection.findOne({
      eventId,
      email,
    });
    if (alreadyRegistered) {
      return res.send({ message: 'Already registered' });
    }
    const registerInfo = {
      eventId,
      eventTitle,
      email,
      registeredAt: new Date(),
    };
    const result = await eventRegisterCollection.insertOne(registerInfo);
    res.send(result);
  });

  // ================= EVENTS API =================
  // CREATE EVENT (manager / club owner)
  app.post('/events', verifyFBToken, async (req, res) => {
    const event = req.body;
    if (!event.clubId || !event.clubName || !event.title || !event.dateTime) {
      return res.status(400).send({ message: 'Missing required fields' });
    }
    // security check
    if (event.createrEmail !== req.decoded_email) {
      return res.status(403).send({ message: 'Forbidden access' });
    }
    const newEvent = {
      ...event,
      clubId: new ObjectId(event.clubId),
      createdAt: new Date(),
      status: 'upcoming',
    };
    const result = await eventcollection.insertOne(newEvent);
    res.send(result);
  });

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


  //addd new id for enent 
// ================= GET SINGLE EVENT =================
// run() ফাংশনের ভিতরে, অন্য route-গুলোর পাশে যোগ করো

app.get('/events/:id', async (req, res) => {
  try {
    const id = req.params.id;

    // ID valid কি না চেক (optional কিন্তু ভালো)
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid event ID format' });
    }

    const event = await eventcollection.findOne({ _id: new ObjectId(id) });

    if (!event) {
      return res.status(404).json({ message: 'Event not found' });
    }

    res.json(event);
  } catch (error) {
    console.error('Error in /events/:id:', error);
    res.status(500).json({ message: 'Server error while fetching event' });
  }
});
  //
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

  // ================= APPROVED CLUB NAMES (FOR DROPDOWN) =================
  app.get('/approved-club-names', async (req, res) => {
    const clubs = await clubcollection
      .find({ status: 'approved' })
      .project({ clubName: 1 })
      .toArray();
    res.send(clubs);
  });

  // ================= APPROVED CLUBS (WITH CLUBNAME FILTER AND SEARCH) =================
  app.get('/approved-clubs', async (req, res) => {
    try {
      const { clubName, search } = req.query;
      let query = { status: 'approved' };
      // dropdown selection
      if (clubName && clubName !== 'ALL') {
        query.clubName = clubName;
      }
      // search (only if no specific clubName selected, to avoid conflict)
      if (search && search.trim() !== '' && (!clubName || clubName === 'ALL')) {
        query.clubName = { $regex: search, $options: 'i' };
      }
      const result = await clubcollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    } catch (err) {
      console.error('Approved clubs fetch error:', err);
      res.status(500).send({ message: 'Server error' });
    }
  });

  // ================= GET MY EVENTS =================
  app.get('/my-events', verifyFBToken, async (req, res) => {
    const email = req.decoded_email;
    const events = await eventcollection
      .find({ createrEmail: email })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(events);
  });

  // ================= DELETE EVENT =================
  app.delete('/events/:id', verifyFBToken, async (req, res) => {
    const id = req.params.id;
    const email = req.decoded_email;
    const event = await eventcollection.findOne({ _id: new ObjectId(id) });
    if (!event) {
      return res.status(404).send({ message: 'Event not found' });
    }
    if (event.createrEmail !== email) {
      return res.status(403).send({ message: 'Forbidden access' });
    }
    const result = await eventcollection.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  });

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