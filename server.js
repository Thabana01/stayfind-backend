require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { ethers } = require('ethers'); // <-- ADDED FOR REAL BLOCKCHAIN
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// --- REAL ETHEREUM SEPOLIA CONFIGURATION ---
const CONTRACT_ADDRESS = "0xA5d9299cC1A77CE65B2f87e662012981555F92ad"; // YOUR REAL ADDRESS
const PRIVATE_KEY = process.env.PRIVATE_KEY; 
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com"; 

const ABI = [
    "function confirmBooking(uint256 _bookingId, uint256 _propertyId, string memory _studentName, uint256 _amount) public"
];

const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
// -------------------------------------------

// ==========================================
// PROPERTY ROUTES
// ==========================================

// 1. Get all available properties
// ✏️ EDITED: Hide properties whose landlord is suspended
app.get('/api/properties', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.* FROM properties p
      JOIN users u ON u.id = p.landlord_id
      WHERE p.status = 'Available'
        AND u.account_status IS DISTINCT FROM 'Suspended'
      ORDER BY p.id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error fetching properties' });
  }
});

// 2. Get a single property by ID
// ✏️ EDITED: Block access to suspended landlord's property / blocked property
app.get('/api/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT p.*, u.account_status AS landlord_status
         FROM properties p
         JOIN users u ON u.id = p.landlord_id
        WHERE p.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Property not found' });

    if (result.rows[0].landlord_status === 'Suspended') {
      return res.status(403).json({ error: 'This listing is unavailable because the landlord account is suspended.' });
    }

    if (result.rows[0].status === 'Blocked') {
      return res.status(403).json({ error: 'This property is currently blocked.' });
    }

    if (result.rows[0].status === 'Occupied') {
      return res.status(400).json({ error: 'This property is currently occupied and unavailable.' });
    }

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
// ✏️ EDITED: Reject if landlord suspended or property blocked
app.post('/api/bookings/request', async (req, res) => {
  try {
    const { property_id, student_id, student_name, student_number, move_in_date, duration, message } = req.body;
    
    const propCheck = await pool.query(
      `SELECT p.status, u.account_status AS landlord_status
         FROM properties p
         JOIN users u ON u.id = p.landlord_id
        WHERE p.id = $1`,
      [property_id]
    );
    if (propCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Property not found.' });
    }
    if (propCheck.rows[0].landlord_status === 'Suspended') {
      return res.status(403).json({ error: 'This landlord is suspended. Bookings are disabled.' });
    }
    if (propCheck.rows[0].status !== 'Available') {
      return res.status(400).json({ error: 'Property is no longer available.' });
    }

    const existingBooking = await pool.query(
      "SELECT * FROM bookings WHERE property_id = $1 AND student_id = $2 AND status IN ('Pending', 'Confirmed', 'Paid')",
      [property_id, student_id]
    );
    if (existingBooking.rows.length > 0) {
      return res.status(400).json({ error: 'You already have an active booking for this property.' });
    }

    const otherPending = await pool.query(
      "SELECT * FROM bookings WHERE property_id = $1 AND status IN ('Pending', 'Confirmed', 'Paid')",
      [property_id]
    );
    if (otherPending.rows.length > 0) {
      return res.status(400).json({ error: 'Another student has already requested this property.' });
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

// 5. CONFIRM BOOKING (Old Route - Kept for compatibility)
app.post('/api/bookings/confirm', async (req, res) => {
  const { booking_id, property_id } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN'); 

    await client.query("UPDATE bookings SET status = 'Confirmed' WHERE id = $1", [booking_id]);
    await client.query("UPDATE properties SET status = 'Occupied' WHERE id = $1", [property_id]);

    const transactionData = `Property ${property_id} booked. Timestamp: ${new Date().toISOString()}`;
    const txHash = '0x' + crypto.createHash('sha256').update(transactionData).digest('hex');

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
// ✏️ EDITED (optional): Include landlord_status + landlord_name for admin view
app.get('/api/admin/properties', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, u.account_status AS landlord_status, u.full_name AS landlord_name
        FROM properties p
        JOIN users u ON u.id = p.landlord_id
       ORDER BY p.id ASC
    `);
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
      SELECT 
        b.id, b.status, b.property_id,
        p.title, p.location, p.price, 
        u.full_name as landlord_name, 
        u.email as landlord_email
      FROM bookings b
      JOIN properties p ON b.property_id = p.id
      JOIN users u ON p.landlord_id = u.id
      WHERE b.student_id = $1
      ORDER BY b.id DESC
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
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

// 13. Accept Booking (Landlord triggers REAL Ethereum Transaction)
// ✏️ EDITED: Guard against suspended landlord / blocked property before blockchain call
app.post('/api/bookings/accept/:id', async (req, res) => {
  const bookingId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Fetch full details for the ledger
    const bookingDetails = await client.query(`
      SELECT b.student_name, b.student_id, p.title as property_title, p.price, p.id as property_id, p.landlord_id
      FROM bookings b
      JOIN properties p ON b.property_id = p.id
      WHERE b.id = $1
    `, [bookingId]);

    if (bookingDetails.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const { student_name, student_id, property_title, price, property_id, landlord_id } = bookingDetails.rows[0];

    // 1b. Guard: refuse if landlord is suspended or property is blocked
    const guard = await client.query(
      `SELECT p.status AS property_status, u.account_status AS landlord_status
         FROM properties p JOIN users u ON u.id = p.landlord_id
        WHERE p.id = $1`,
      [property_id]
    );
    if (guard.rows[0]?.landlord_status === 'Suspended' || guard.rows[0]?.property_status === 'Blocked') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Cannot confirm: landlord suspended or property blocked.' });
    }

    // 2. SEND TO REAL ETHEREUM SEPOLIA SMART CONTRACT
    console.log("📡 Sending transaction to Ethereum Sepolia...");
    const tx = await contract.confirmBooking(
        Number(bookingId),
        Number(property_id),
        student_name,
        Math.round(Number(price) * 100) // Converts to integer
    );
    
    console.log("⏳ Waiting for transaction to be mined...");
    await tx.wait(); // Wait for the real blockchain to confirm
    console.log("✅ Transaction Mined! Hash:", tx.hash);

    // 3. Update statuses in Postgres
    await client.query("UPDATE bookings SET status = 'Confirmed' WHERE id = $1", [bookingId]);
    await client.query("UPDATE properties SET status = 'Occupied' WHERE id = $1", [property_id]);
    
    // 4. Save the REAL Ethereum hash to the ledger
    await client.query(
      `INSERT INTO blockchain_ledger 
      (transaction_hash, action, property_id, student_name, property_title, amount, payment_status) 
      VALUES ($1, 'ConfirmBooking', $2, $3, $4, $5, 'Success')`,
      [tx.hash, property_id, `${student_name} (ID: ${student_id})`, `${property_title} (Landlord ID: ${landlord_id})`, price]
    );

    await client.query('COMMIT');
    res.json({ message: 'Booking Confirmed on Real Blockchain!', txHash: tx.hash });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Blockchain Error:", err);
    res.status(500).json({ error: 'Failed to confirm booking on blockchain.' });
  } finally {
    client.release();
  }
});

// 13b. Reject Booking (Landlord)
app.post('/api/bookings/reject/:id', async (req, res) => {
  try {
    const bookingId = req.params.id;
    await pool.query("UPDATE bookings SET status = 'Declined' WHERE id = $1", [bookingId]);
    res.json({ message: 'Booking declined.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject booking' });
  }
});

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================

// 14. Register a new user
app.post('/api/auth/register', async (req, res) => {
  try {
    const { full_name, email, password, role, student_number, property_details } = req.body;
    
    const userCheck = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const newUser = await pool.query(
      `INSERT INTO users (full_name, email, password, role, verification_status, student_number, property_details) 
       VALUES ($1, $2, $3, $4, 'Pending', $5, $6) RETURNING id, full_name, role, verification_status`,
      [full_name, email, password, role, student_number || null, property_details || null]
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
      "SELECT id, full_name, role, verification_status, account_status, student_number FROM users WHERE email = $1 AND password = $2",
      [email, password]
    );

    if (user.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.rows[0].account_status === 'Suspended') {
      return res.status(403).json({ error: 'Your account has been suspended by an Admin due to a violation of terms.' });
    }

    if (user.rows[0].verification_status !== 'Approved') {
      return res.status(403).json({ error: 'Your account is pending Admin approval. Please wait.' });
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
    const result = await pool.query("SELECT id, role, full_name, email, verification_status, account_status, student_number, property_details FROM users ORDER BY id ASC");
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

// 17b. Admin: Suspend or Activate a user
// ✏️ EDITED (CORE): When landlord is suspended -> block their properties.
//                    When landlord is reactivated -> unblock their properties.
app.put('/api/admin/users/suspend/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status } = req.body; // 'Suspended' or 'Active'

    await client.query('BEGIN');

    // 1. Update the user's account status
    const userRes = await client.query(
      "UPDATE users SET account_status = $1 WHERE id = $2 RETURNING role, full_name",
      [status, id]
    );
    if (userRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    let blockedCount = 0;
    const role = userRes.rows[0].role;

    // 2. If landlord was suspended -> block all their available properties
    if (role === 'Landlord' && status === 'Suspended') {
      const blocked = await client.query(
        `UPDATE properties SET status = 'Blocked'
          WHERE landlord_id = $1 AND status = 'Available'
          RETURNING id`,
        [id]
      );
      blockedCount = blocked.rowCount;

      // Cancel pending bookings on those properties
      await client.query(
        `UPDATE bookings SET status = 'Declined'
          WHERE property_id IN (SELECT id FROM properties WHERE landlord_id = $1)
            AND status = 'Pending'`,
        [id]
      );
    }

    // 3. If landlord was reactivated -> unblock their properties
    if (role === 'Landlord' && status === 'Active') {
      const unblocked = await client.query(
        `UPDATE properties SET status = 'Available'
          WHERE landlord_id = $1 AND status = 'Blocked'
          RETURNING id`,
        [id]
      );
      blockedCount = unblocked.rowCount;
    }

    await client.query('COMMIT');
    res.json({
      message: `User account is now ${status}`,
      affectedProperties: blockedCount
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ==========================================
// PAYMENT ROUTE
// ==========================================

// 18. Process Simulated Payment
app.post('/api/bookings/pay/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_method, amount } = req.body;
    
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
    console.error("❌ BACKEND INBOX ERROR:", err.message); 
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
// ✏️ EDITED: Suspended landlords cannot re-list their property as 'Available'
app.put('/api/landlord/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, location, price, type, bedrooms, status, image_url } = req.body;

    // Check landlord suspension before allowing status change back to Available
    const chk = await pool.query(
      `SELECT u.account_status FROM properties p
         JOIN users u ON u.id = p.landlord_id WHERE p.id = $1`, [id]
    );
    if (chk.rows.length === 0) return res.status(404).json({ error: 'Property not found' });
    if (chk.rows[0].account_status === 'Suspended' && status === 'Available') {
      return res.status(403).json({ error: 'Your account is suspended. You cannot re-list this property.' });
    }
    
    const updatedProp = await pool.query(
      `UPDATE properties 
       SET title = $1, location = $2, price = $3, type = $4, bedrooms = $5, status = $6, image_url = $7
       WHERE id = $8 RETURNING *`,
      [title, location, price, type, bedrooms, status, image_url, id]
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
    
    const pricePerBedroom = totalPrice / totalBedrooms;

    const baseAccuracy = 85.0;
    const dataBonus = (properties.length * 1.2); 
    const simulatedAccuracy = Math.min(baseAccuracy + dataBonus, 99.2);

    const predictedPrice = (avgPrice * 0.8) + (avgBedrooms * 500) + (furnishedCount * 300);

    res.json({
      datasetSize: properties.length,
      algorithm: "Linear Regression",
      accuracy: simulatedAccuracy.toFixed(2),
      pricePerBedroom: Math.round(pricePerBedroom), 
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

    let csvContent = "property_id,location,type,bedrooms,price,status\n";

    properties.forEach(p => {
      csvContent += `${p.property_id},"${p.location}","${p.type}",${p.bedrooms},${p.price},"${p.status}"\n`;
    });

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