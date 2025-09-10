import mysql from "mysql2/promise";

async function setup() {
  const connection = await mysql.createConnection({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    port: process.env.MYSQLPORT,
  });

  const createTables = `
  CREATE TABLE IF NOT EXISTS requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nationalId VARCHAR(20),
    seatNumber VARCHAR(20),
    phone VARCHAR(20),
    email VARCHAR(100),
    screenshot VARCHAR(255),
    paid BOOLEAN DEFAULT FALSE,
    result JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nationalId VARCHAR(20),
    phone VARCHAR(20),
    email VARCHAR(100),
    senderPhone VARCHAR(20),
    screenshot VARCHAR(255),
    reserved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    seatNumber VARCHAR(20),
    name VARCHAR(100),
    stage VARCHAR(50),
    gradeLevel VARCHAR(50),
    schoolName VARCHAR(100),
    notes TEXT,
    mainSubjects JSON,
    additionalSubjects JSON,
    totalScore INT,
    totalOutOf INT,
    percentage DECIMAL(5,2)
  );
  `;

  await connection.query(createTables);
  console.log("✅ Tables created successfully!");
  await connection.end();
}

setup().catch(console.error);
