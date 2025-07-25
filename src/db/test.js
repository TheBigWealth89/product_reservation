      import { pool } from "./index.js";

async function testDb() {
  try {
    const res = await pool.query('SELECT * FROM products');
    console.log(res.rows);
  } catch (err) {
    console.error('DB Error:', err);
  }
}

testDb();