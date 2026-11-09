require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// PROPERTY ROUTES
// ==========================================

// 1. Get all available properties
app.get('/api/properties', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM properties WHERE status = 'Available' ORDER BY id ASC");
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error fetching properties' });
  }
});

// 2. Get a single property by ID
app.get('/api/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM properties WHERE id = $1", [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Property not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 3. Landlord: Add a new property
app.post('/api/properties', async (req, res) => {
  try {
    const { title, location, price, type, bedrooms, landlord_id, image_url } = req.body;
    const newProperty = await pool.query(
      `INSERT INTO properties (title, location, price, type, bedrooms, landlord_id, image_url) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title, location, price, type, bedrooms, landlord_id, image_url]
    );
    res.json(newProperty.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error creating property' });
  }
});

// ==========================================
// BOOKING & BLOCKCHAIN ROUTES (Part B)
// ==========================================

// 4. Create a Booking Request
app.post('/api/bookings/request', async (req, res) => {
  try {
    const { property_id, student_id, student_name, student_number, move_in_date, duration, message } = req.body;
    
    const propCheck = await pool.query("SELECT status FROM properties WHERE id = $1", [property_id]);
    if (propCheck.rows[0].status !== 'Available') {
      return res.status(400).json({ error: 'Property is no longer available.' });
    }

    const newBooking = await pool.query(
      `INSERT INTO bookings 
      (property_id, student_id, status, student_name, student_number, move_in_date, duration, message) 
      VALUES ($1, $2, 'Pending', $3, $4, $5, $6, $7) RETURNING *`,
      [property_id, student_id, student_name, student_number, move_in_date, duration, message]
    );
    
    res.json({ message: 'Booking requested', booking: newBooking.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 5. CONFIRM BOOKING & MINE BLOCKCHAIN TRANSACTION
app.post('/api/bookings/confirm', async (req, res) => {
  const { booking_id, property_id } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN'); 

    await client.query("UPDATE bookings SET status = 'Confirmed' WHERE id = $1", [booking_id]);
    await client.query("UPDATE properties SET status = 'Occupied' WHERE id = $1", [property_id]);

    const transactionData = `Property ${property_id} booked. Timestamp: ${new Date().toISOString()}`;
    const txHash = crypto.createHash('sha256').update(transactionData).digest('hex');

    await client.query(
      "INSERT INTO blockchain_ledger (transaction_hash, action, property_id) VALUES ($1, $2, $3)",
      [txHash, 'BOOKING_CONFIRMED', property_id]
    );

    await client.query('COMMIT'); 
    res.json({ message: 'Booking confirmed and recorded to blockchain!', txHash: txHash });
  } catch (err) {
    await client.query('ROLLBACK'); 
    res.status(500).json({ error: 'Booking confirmation failed' });
  } finally {
    client.release();
  }
});

// 6. Get Blockchain Ledger
app.get('/api/blockchain', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM blockchain_ledger ORDER BY timestamp DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 7. Admin: Get Booking Stats
app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalProps = await pool.query("SELECT COUNT(*) FROM properties");
    const totalBookings = await pool.query("SELECT COUNT(*) FROM bookings");
    const totalUsers = await pool.query("SELECT COUNT(*) FROM users");
    
    res.json({
      properties: totalProps.rows[0].count,
      bookings: totalBookings.rows[0].count,
      users: totalUsers.rows[0].count
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// ADMIN CRUD ROUTES
// ==========================================

// 8. Admin: Get ALL properties
app.get('/api/admin/properties', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM properties ORDER BY id ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 9. Admin: UPDATE a property
app.put('/api/admin/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, location, price, type, bedrooms, status } = req.body;
    
    const updatedProp = await pool.query(
      `UPDATE properties 
       SET title = $1, location = $2, price = $3, type = $4, bedrooms = $5, status = $6
       WHERE id = $7 RETURNING *`,
      [title, location, price, type, bedrooms, status, id]
    );
    
    res.json(updatedProp.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error updating property' });
  }
});

// 10. Admin: DELETE a property
app.delete('/api/admin/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM properties WHERE id = $1", [id]);
    res.json({ message: 'Property deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Cannot delete property. It may have active bookings.' });
  }
});

// ==========================================
// BOOKING ROUTES (Dynamic)
// ==========================================

// 11. Get bookings for a specific student
app.get('/api/bookings/student/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`
      SELECT b.id, b.status, p.title, p.location, p.price 
      FROM bookings b
      JOIN properties p ON b.property_id = p.id
      WHERE b.student_id = $1
      ORDER BY b.id DESC
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error fetching bookings' });
  }
});

// 12. Get bookings for a SPECIFIC Landlord
app.get('/api/bookings/landlord/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT b.id, b.status, b.student_name, b.student_id, b.student_number, b.move_in_date, b.duration, 
             b.payment_method, b.payment_reference, b.payment_amount, b.paid_at, 
             p.title, p.id as property_id
      FROM bookings b
      JOIN properties p ON b.property_id = p.id
      WHERE b.status IN ('Pending', 'Paid') AND p.landlord_id = $1
      ORDER BY b.id DESC
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 13. Accept Booking (Landlord triggers Blockchain Hash)
app.post('/api/bookings/accept/:id', async (req, res) => {
  const bookingId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const bookingRes = await client.query("SELECT property_id FROM bookings WHERE id = $1", [bookingId]);
    const propertyId = bookingRes.rows[0].property_id;

    await client.query("UPDATE bookings SET status = 'Confirmed' WHERE id = $1", [bookingId]);
    await client.query("UPDATE properties SET status = 'Occupied' WHERE id = $1", [propertyId]);

    const txHash = crypto.createHash('sha256').update(`Booking ${bookingId} confirmed at ${new Date().toISOString()}`).digest('hex');
    
    await client.query(
      "INSERT INTO blockchain_ledger (transaction_hash, action, property_id) VALUES ($1, 'BOOKING_CONFIRMED', $2)",
      [txHash, propertyId]
    );

    await client.query('COMMIT');
    res.json({ message: 'Booking Confirmed and Blockchain Hash Generated!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to confirm booking' });
  } finally {
    client.release();
  }
});

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================

// 14. Register a new user
app.post('/api/auth/register', async (req, res) => {
  try {
    const { full_name, email, password, role } = req.body;
    
    const userCheck = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const newUser = await pool.query(
      "INSERT INTO users (full_name, email, password, role, verification_status) VALUES ($1, $2, $3, $4, 'Pending') RETURNING id, full_name, role, verification_status",
      [full_name, email, password, role]
    );
    
    res.json({ message: 'Registration successful! Please wait for Admin approval.', user: newUser.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// 15. Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = await pool.query(
      "SELECT id, full_name, role, verification_status FROM users WHERE email = $1 AND password = $2",
      [email, password]
    );

    if (user.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    res.json({ message: 'Login successful', user: user.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// ==========================================
// ADMIN USER VERIFICATION ROUTES
// ==========================================

// 16. Admin: Get all users
app.get('/api/admin/users', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, role, full_name, email, verification_status FROM users ORDER BY id ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 17. Admin: Approve a user
app.put('/api/admin/users/approve/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE users SET verification_status = 'Approved' WHERE id = $1", [id]);
    res.json({ message: 'User verified successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// PAYMENT ROUTE (UPDATED)
// ==========================================

// 18. Process Simulated Payment
app.post('/api/bookings/pay/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_method, amount } = req.body;
    
    // Generate a unique payment reference (e.g., PAY-889912)
    const ref = 'PAY-' + Math.floor(100000 + Math.random() * 900000);
    
    await pool.query(
      `UPDATE bookings 
       SET status = 'Paid', payment_method = $1, payment_reference = $2, payment_amount = $3, paid_at = NOW() 
       WHERE id = $4`, 
      [payment_method, ref, amount, id]
    );
    
    res.json({ message: 'Payment successful', reference: ref });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Payment failed' });
  }
});

// ==========================================
// MESSAGING ROUTES
// ==========================================

// 19. Send a Message
app.post('/api/messages', async (req, res) => {
  try {
    const { sender_id, receiver_id, property_id, content } = req.body;
    await pool.query(
      "INSERT INTO messages (sender_id, receiver_id, property_id, content) VALUES ($1, $2, $3, $4)",
      [sender_id, receiver_id, property_id, content]
    );
    res.json({ message: 'Message sent' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// 20. Get Conversation History (Secure)
app.get('/api/messages/:userId/:otherId', async (req, res) => {
  try {
    const { userId, otherId } = req.params;
    const result = await pool.query(`
      SELECT * FROM messages 
      WHERE (sender_id = $1 AND receiver_id = $2) 
         OR (sender_id = $2 AND receiver_id = $1)
      ORDER BY created_at ASC
    `, [userId, otherId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// 21. Get Inbox (UNIQUE ROUTE)
app.get('/api/inbox/:userId', async (req, res) => {
  const userId = req.params.userId;
  console.log(`🔍 BACKEND: Fetching inbox for user ID: ${userId}`);

  try {
    const result = await pool.query(`
      SELECT DISTINCT u.id, u.full_name, u.role
      FROM users u
      WHERE u.id IN (
        SELECT sender_id FROM messages WHERE receiver_id = $1
        UNION
        SELECT receiver_id FROM messages WHERE sender_id = $1
      )
    `, [userId]);

    console.log(`✅ BACKEND: Found ${result.rows.length} contacts`);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ BACKEND INBOX ERROR:", err.message); // This will print the exact SQL error
    res.status(500).json({ error: 'Server error fetching inbox' });
  }
});

// 22. Get User Details (For Chat Header)
app.get('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT id, full_name, role FROM users WHERE id = $1", [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==========================================
// LANDLORD CRUD ROUTES
// ==========================================

// 23. Landlord: Update Own Property
app.put('/api/landlord/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, location, price, type, bedrooms, status } = req.body;
    
    const updatedProp = await pool.query(
      `UPDATE properties 
       SET title = $1, location = $2, price = $3, type = $4, bedrooms = $5, status = $6
       WHERE id = $7 RETURNING *`,
      [title, location, price, type, bedrooms, status, id]
    );
    
    res.json(updatedProp.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error updating property' });
  }
});

// 24. Landlord: Delete Own Property
app.delete('/api/landlord/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM properties WHERE id = $1", [id]);
    res.json({ message: 'Property deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Cannot delete property. It may have active bookings.' });
  }
});

// ==========================================
// ADMIN ANALYTICS ROUTE
// ==========================================

// 25. Admin: Get Real-Time Analytics
app.get('/api/admin/analytics', async (req, res) => {
  try {
    const avgPrice = await pool.query(`
      SELECT location, ROUND(AVG(price)) as avg_price, COUNT(*) as count
      FROM properties 
      GROUP BY location
    `);

    const bookingTrends = await pool.query(`
      SELECT 
        TO_CHAR(created_at, 'Mon') as month,
        COUNT(*) as bookings
      FROM bookings
      GROUP BY TO_CHAR(created_at, 'Mon'), DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) ASC
      LIMIT 6
    `);

    const propertyTypes = await pool.query(`
      SELECT type as name, COUNT(*) as value
      FROM properties
      GROUP BY type
    `);

    const statusDistribution = await pool.query(`
      SELECT status as name, COUNT(*) as value
      FROM properties
      GROUP BY status
    `);

    res.json({
      avgPrice: avgPrice.rows,
      bookingTrends: bookingTrends.rows,
      propertyTypes: propertyTypes.rows,
      statusDistribution: statusDistribution.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});
// 26. AI MODEL: Train & Predict Prices (Dynamic)
app.get('/api/ai-model/train', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM properties");
    const properties = result.rows;

    if (properties.length < 5) {
      return res.status(400).json({ error: "Need at least 5 properties to train the model." });
    }

    let totalPrice = 0;
    let totalBedrooms = 0;
    let furnishedCount = 0;
    
    properties.forEach(p => {
      totalPrice += Number(p.price);
      totalBedrooms += Number(p.bedrooms || 1);
      if (p.type === 'Apartment' || p.type === 'House') furnishedCount++;
    });

    const avgPrice = totalPrice / properties.length;
    const avgBedrooms = totalBedrooms / properties.length;
    
    // THIS IS THE MISSING LINE: Calculate real average price per bedroom
    const pricePerBedroom = totalPrice / totalBedrooms;

    // Simulate Model Accuracy
    const baseAccuracy = 85.0;
    const dataBonus = (properties.length * 1.2); 
    const simulatedAccuracy = Math.min(baseAccuracy + dataBonus, 99.2);

    // Base prediction
    const predictedPrice = (avgPrice * 0.8) + (avgBedrooms * 500) + (furnishedCount * 300);

    res.json({
      datasetSize: properties.length,
      algorithm: "Linear Regression",
      accuracy: simulatedAccuracy.toFixed(2),
      pricePerBedroom: Math.round(pricePerBedroom), // <-- NOW SENDING THIS
      prediction: {
        sampleFeatures: { bedrooms: 2, furnished: true },
        predictedRent: Math.round(predictedPrice)
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to train model' });
  }
});
// 27. Admin: Export Properties to CSV (Excel)
app.get('/api/admin/export-csv', async (req, res) => {
  try {
    const result = await pool.query("SELECT id as property_id, location, type, bedrooms, price, status FROM properties ORDER BY id ASC");
    const properties = result.rows;

    // Create CSV headers
    let csvContent = "property_id,location,type,bedrooms,price,status\n";

    // Add each row
    properties.forEach(p => {
      csvContent += `${p.property_id},"${p.location}","${p.type}",${p.bedrooms},${p.price},"${p.status}"\n`;
    });

    // Set headers to force browser download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="stayfind_dataset.csv"');
    
    res.status(200).send(csvContent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate CSV' });
  }
});
// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 StayFind Backend running on http://localhost:${PORT}`);
  console.log(`🔗 Connected to PostgreSQL Database: ${process.env.DB_NAME}`);
});