require('dotenv').config();
const mongoose = require('mongoose');

// Assuming the DB URI is standard local or from env, but let's just log what we can.
// Actually, it's better to just read the backend code to see what the URI is.
const URI = process.env.MONGO_URL || 'mongodb://localhost:27017/second_brain';

async function check() {
  await mongoose.connect(URI);
  const db = mongoose.connection.db;
  const tasks = await db.collection('todos').find({ visibility: 'workspace' }).sort({ _id: -1 }).limit(3).toArray();
  console.log("Last 3 Workspace Tasks:", JSON.stringify(tasks, null, 2));
  process.exit(0);
}

check().catch(console.error);
